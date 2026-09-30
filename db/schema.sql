-- ============================================================
--  Lume Literário — Esquema do banco (PostgreSQL / Supabase)
--  ESTADO FINAL (após todas as migrations): snake_case + PKs UUID.
--  Recria toda a estrutura: tabelas, integridade, índices, regras
--  de negócio (funções/triggers/procedure), views, RLS e seed.
--  Fonte de verdade para deploy: supabase/migrations/. Este arquivo
--  é a referência legível e completa do schema resultante.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
-- Schema `extensions` (não `public`), mesmo padrão já usado para pgcrypto/uuid-ossp
-- neste projeto — evita o aviso "Extension in Public" do Supabase Advisor.
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;  -- normalizar_busca() — Achado 25 (busca fuzzy)
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;   -- índices/fuzzy match — Achado 25 (busca fuzzy)

-- ------------------------------------------------------------
-- 1. TABELAS
-- ------------------------------------------------------------
CREATE TABLE autor (
    autor_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome_autor    varchar(100) NOT NULL,
    nacionalidade varchar(50),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE categoria (
    categoria_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome_categoria varchar(60) NOT NULL,
    -- descricao adicionada em 17/07/2026 (migration
    -- 20260717000000_criacao_rapida_categoria_editora.sql) — campo opcional do
    -- mini-formulário de criação rápida de categoria no cadastro de Livro.
    descricao      text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE editora (
    editora_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome_editora varchar(100) NOT NULL,
    cidade       varchar(80),
    -- site adicionado em 17/07/2026 (mesma migration acima) — campo opcional
    -- do mini-formulário de criação rápida de editora no cadastro de Livro.
    site         varchar(200),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE livro (
    livro_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    titulo         varchar(200) NOT NULL,
    isbn           varchar(20)  NOT NULL UNIQUE,
    ano_publicacao smallint,
    editora_id     uuid NOT NULL,
    categoria_id   uuid NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE livro_autor (
    livro_id   uuid NOT NULL,
    autor_id   uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (livro_id, autor_id)
);

CREATE TABLE exemplar (
    exemplar_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo_patrimonial varchar(20) NOT NULL UNIQUE,
    livro_id           uuid NOT NULL,
    status             varchar(20) NOT NULL DEFAULT 'Disponivel',
    -- motivo_baixa adicionado em 16/07/2026 (migration 20260716020000_exemplares_reforma.sql).
    -- Nullable: obrigatoriedade quando status='Baixado' é validada na Edge Function, não aqui
    -- (um CHECK travaria os registros Baixado que já existiam antes desta coluna existir).
    motivo_baixa       varchar(20),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    -- 'Manutencao' adicionado em 16/07/2026 (mesma migration) — reforma da tela de Exemplares.
    CONSTRAINT chk_exemplar_status CHECK (status IN ('Disponivel','Emprestado','Reservado','Baixado','Manutencao')),
    CONSTRAINT chk_motivo_baixa CHECK (motivo_baixa IS NULL OR motivo_baixa IN ('Perda','Extravio','Danificado','Descartado','Outro'))
);

CREATE TABLE usuario (
    usuario_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome          varchar(100) NOT NULL,
    email         varchar(100) NOT NULL UNIQUE,
    cpf           varchar(11)  NOT NULL UNIQUE,
    telefone      varchar(20),
    data_cadastro date    NOT NULL DEFAULT CURRENT_DATE,
    ativo         boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_cpf_format CHECK (cpf ~ '^\d{11}$')
);

CREATE TABLE emprestimo (
    emprestimo_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id     uuid NOT NULL,
    exemplar_id    uuid NOT NULL,
    data_retirada  date NOT NULL DEFAULT CURRENT_DATE,
    data_prevista  date NOT NULL,
    data_devolucao date,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_datas CHECK (data_prevista >= data_retirada)
);

CREATE TABLE multa (
    multa_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    emprestimo_id  uuid NOT NULL UNIQUE,
    dias_atraso    integer NOT NULL,
    valor_dia      numeric(6,2) NOT NULL DEFAULT 2.00,
    pago           boolean NOT NULL DEFAULT false,
    valor_total    numeric(10,2) GENERATED ALWAYS AS (dias_atraso::numeric * valor_dia) STORED,
    data_pagamento timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_dias_atraso_positivo CHECK (dias_atraso >= 0)
);

CREATE TABLE reserva (
    reserva_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id   uuid NOT NULL,
    livro_id     uuid NOT NULL,
    data_reserva date NOT NULL DEFAULT CURRENT_DATE,
    status       varchar(20) NOT NULL DEFAULT 'Ativa',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_reserva_status CHECK (status IN ('Ativa','Atendida','Cancelada'))
);

CREATE TABLE configuracao (
    chave          varchar(50) PRIMARY KEY,
    valor_numerico numeric(10,2),
    descricao      text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- RBAC: papéis de acesso à aplicação (admin / bibliotecario / consulta).
-- Não confundir com "leitor" no sentido de usuário/leitor da biblioteca —
-- esses são registros na tabela `usuario`, uma entidade totalmente
-- separada que não acessa o sistema. `consulta` é o papel de menor
-- privilégio para quem só precisa enxergar o sistema sem editar nada.
CREATE TABLE app_perfil (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    uuid UNIQUE,
    email      text UNIQUE,
    papel      text NOT NULL DEFAULT 'consulta',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_papel CHECK (papel IN ('admin','bibliotecario','consulta'))
);

-- Trilha de auditoria das escritas (gravada pela API/service_role)
CREATE TABLE log_auditoria (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usuario_email text,
    acao          text NOT NULL,
    entidade      text,
    registro_id   text,
    detalhe       jsonb,
    criado_em     timestamptz NOT NULL DEFAULT now()
);

-- Observabilidade: erros da API
CREATE TABLE log_erro (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    acao          text,
    usuario_email text,
    mensagem      text NOT NULL,
    detalhe       jsonb,
    criado_em     timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 2. CHAVES ESTRANGEIRAS (com ações por regra de negócio)
-- ------------------------------------------------------------
ALTER TABLE livro       ADD CONSTRAINT livro_editora_id_fkey      FOREIGN KEY (editora_id)    REFERENCES editora(editora_id)     ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE livro       ADD CONSTRAINT livro_categoria_id_fkey    FOREIGN KEY (categoria_id)  REFERENCES categoria(categoria_id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE livro_autor ADD CONSTRAINT livro_autor_livro_id_fkey FOREIGN KEY (livro_id)      REFERENCES livro(livro_id)         ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE livro_autor ADD CONSTRAINT livro_autor_autor_id_fkey FOREIGN KEY (autor_id)      REFERENCES autor(autor_id)         ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE exemplar    ADD CONSTRAINT exemplar_livro_id_fkey     FOREIGN KEY (livro_id)      REFERENCES livro(livro_id)         ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE emprestimo  ADD CONSTRAINT emprestimo_usuario_id_fkey FOREIGN KEY (usuario_id)    REFERENCES usuario(usuario_id)     ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE emprestimo  ADD CONSTRAINT emprestimo_exemplar_id_fkey FOREIGN KEY (exemplar_id)  REFERENCES exemplar(exemplar_id)   ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE multa       ADD CONSTRAINT multa_emprestimo_id_fkey   FOREIGN KEY (emprestimo_id) REFERENCES emprestimo(emprestimo_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE reserva     ADD CONSTRAINT reserva_usuario_id_fkey    FOREIGN KEY (usuario_id)    REFERENCES usuario(usuario_id)     ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE reserva     ADD CONSTRAINT reserva_livro_id_fkey      FOREIGN KEY (livro_id)      REFERENCES livro(livro_id)         ON UPDATE CASCADE ON DELETE CASCADE;

-- ------------------------------------------------------------
-- 3. ÍNDICES (além dos criados por PK/UNIQUE)
-- ------------------------------------------------------------
CREATE INDEX idx_livro_editora_id        ON livro(editora_id);
CREATE INDEX idx_livro_categoria_id      ON livro(categoria_id);
CREATE INDEX idx_livro_autor_autor_id    ON livro_autor(autor_id);
CREATE INDEX idx_exemplar_livro_id       ON exemplar(livro_id);
CREATE INDEX idx_exemplar_status         ON exemplar(status);
CREATE INDEX idx_emprestimo_usuario_id   ON emprestimo(usuario_id);
CREATE INDEX idx_emprestimo_exemplar_id  ON emprestimo(exemplar_id);
CREATE INDEX idx_emprestimo_data_prevista ON emprestimo(data_prevista);
CREATE INDEX idx_emprestimo_data_devolucao ON emprestimo(data_devolucao);
CREATE INDEX idx_multa_pago              ON multa(pago);
CREATE INDEX idx_reserva_usuario_id      ON reserva(usuario_id);
CREATE INDEX idx_reserva_livro_id        ON reserva(livro_id);
CREATE INDEX idx_reserva_status          ON reserva(status);
CREATE INDEX idx_usuario_ativo           ON usuario(ativo);
CREATE INDEX idx_app_perfil_email        ON app_perfil(email);
CREATE INDEX idx_log_criado_em           ON log_auditoria(criado_em DESC);
CREATE INDEX idx_log_erro_criado_em      ON log_erro(criado_em DESC);

-- (Índices GIN trigram da busca fuzzy ficam no fim da seção 4 — usam
-- normalizar_busca(), que precisa existir primeiro.)

-- ------------------------------------------------------------
-- 4. FUNÇÕES E REGRAS DE NEGÓCIO
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE OR REPLACE FUNCTION public.set_multa_pagamento()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NEW.pago IS TRUE AND (OLD.pago IS DISTINCT FROM TRUE) THEN NEW.data_pagamento = now(); END IF;
  IF NEW.pago IS NOT TRUE THEN NEW.data_pagamento = NULL; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.fn_emprestimo_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  UPDATE exemplar SET status = 'Emprestado' WHERE exemplar_id = NEW.exemplar_id;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.fn_emprestimo_update()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF OLD.data_devolucao IS NULL AND NEW.data_devolucao IS NOT NULL THEN
    UPDATE exemplar SET status = 'Disponivel' WHERE exemplar_id = NEW.exemplar_id;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.fn_check_exemplar_disponivel()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE
  v_status        TEXT;
  v_usuario_ativo BOOLEAN;
BEGIN
  SELECT ativo INTO v_usuario_ativo FROM usuario WHERE usuario_id = NEW.usuario_id;
  IF NOT v_usuario_ativo THEN
    RAISE EXCEPTION 'Usuário % está inativo e não pode realizar empréstimos.', NEW.usuario_id;
  END IF;

  SELECT status INTO v_status FROM exemplar WHERE exemplar_id = NEW.exemplar_id FOR UPDATE;
  IF v_status <> 'Disponivel' THEN
    RAISE EXCEPTION 'Exemplar % não está disponível para empréstimo (status atual: %).', NEW.exemplar_id, v_status;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE PROCEDURE public.registrar_devolucao(IN p_emprestimo_id uuid)
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE
  v_data_prevista DATE;
  v_dias_atraso   INT;
  v_multa_existe  BOOLEAN;
  v_valor_dia     NUMERIC(10,2);
  v_livro_id      uuid;
  v_reserva_id    uuid;
BEGIN
  SELECT COALESCE((SELECT valor_numerico FROM configuracao WHERE chave = 'valor_dia_multa'), 2.00)
  INTO v_valor_dia;

  SELECT data_prevista INTO v_data_prevista
  FROM emprestimo WHERE emprestimo_id = p_emprestimo_id AND data_devolucao IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Empréstimo % não encontrado ou já devolvido.', p_emprestimo_id;
  END IF;

  UPDATE emprestimo SET data_devolucao = CURRENT_DATE WHERE emprestimo_id = p_emprestimo_id;

  v_dias_atraso := GREATEST(0, CURRENT_DATE - v_data_prevista);
  IF v_dias_atraso > 0 THEN
    SELECT EXISTS(SELECT 1 FROM multa WHERE emprestimo_id = p_emprestimo_id) INTO v_multa_existe;
    IF NOT v_multa_existe THEN
      INSERT INTO multa(emprestimo_id, dias_atraso, valor_dia, pago)
      VALUES (p_emprestimo_id, v_dias_atraso, v_valor_dia, FALSE);
    END IF;
  END IF;

  SELECT ex.livro_id INTO v_livro_id
  FROM emprestimo em JOIN exemplar ex ON ex.exemplar_id = em.exemplar_id
  WHERE em.emprestimo_id = p_emprestimo_id;

  SELECT reserva_id INTO v_reserva_id
  FROM reserva WHERE livro_id = v_livro_id AND status = 'Ativa'
  ORDER BY data_reserva ASC LIMIT 1;

  IF FOUND THEN
    UPDATE reserva SET status = 'Atendida' WHERE reserva_id = v_reserva_id;
  END IF;
END; $$;

CREATE OR REPLACE FUNCTION public.dashboard_stats()
RETURNS json LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT json_build_object(
    'usuarios',              (SELECT count(*) FROM usuario WHERE ativo),
    'livros',                (SELECT count(*) FROM livro),
    'exemplares',            (SELECT count(*) FROM exemplar),
    'exemplares_disponiveis',(SELECT count(*) FROM exemplar WHERE status = 'Disponivel'),
    'emprestimosAtivos',     (SELECT count(*) FROM emprestimo WHERE data_devolucao IS NULL),
    'reservasPendentes',     (SELECT count(*) FROM reserva WHERE status = 'Ativa'),
    'multasEmAberto',        (SELECT count(*) FROM multa WHERE pago = false)
  );
$$;

-- Distribuição de livros por categoria, usada no gráfico do painel geral.
CREATE OR REPLACE FUNCTION public.categorias_com_livros()
RETURNS TABLE(nome text, total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
SELECT c.nome_categoria AS nome, COUNT(l.livro_id) AS total
FROM public.categoria c
LEFT JOIN public.livro l ON l.categoria_id = c.categoria_id
GROUP BY c.nome_categoria
ORDER BY total DESC;
$$;

-- Papel RBAC do usuário logado (usado nas políticas de RLS de escrita
-- abaixo). Lê a própria linha de app_perfil, permitido pela policy
-- app_perfil_sel_own (user_id = (select auth.uid())). Sem SECURITY DEFINER.
CREATE OR REPLACE FUNCTION public.papel_atual()
RETURNS text LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT papel FROM app_perfil WHERE user_id = auth.uid()
$$;

-- Código patrimonial automático (16/07/2026, migration 20260716020000_exemplares_reforma.sql)
-- — reforma da tela de Exemplares: o usuário não digita mais o código, o banco gera
-- (padrão EX0001.. já usado manualmente antes; sequence começa em 13 porque EX0001..EX0012
-- já existiam sem lacunas no momento da migration).
CREATE SEQUENCE seq_exemplar_codigo START WITH 13;
ALTER SEQUENCE seq_exemplar_codigo OWNED BY exemplar.codigo_patrimonial;

CREATE OR REPLACE FUNCTION public.gerar_codigo_patrimonial()
RETURNS text LANGUAGE sql SET search_path TO 'public' AS $$
  SELECT 'EX' || lpad(nextval('seq_exemplar_codigo')::text, 4, '0');
$$;

ALTER TABLE exemplar ALTER COLUMN codigo_patrimonial SET DEFAULT gerar_codigo_patrimonial();

-- Preview do próximo código patrimonial (17/07/2026, migration
-- 20260717010000_exemplares_feedback2.sql) — feedback sobre a tela de
-- Exemplares: mostra "Código previsto: EX0013" no modal "Novo Exemplar" sem
-- consumir a sequence (só espia last_value/is_called). Não é uma reserva.
CREATE OR REPLACE FUNCTION public.proximo_codigo_patrimonial()
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT 'EX' || lpad((last_value + CASE WHEN is_called THEN 1 ELSE 0 END)::text, 4, '0')
  FROM seq_exemplar_codigo;
$$;
REVOKE ALL ON FUNCTION public.proximo_codigo_patrimonial() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.proximo_codigo_patrimonial() TO service_role;

-- ---- Busca fuzzy/tolerante a acento e erro de digitação (Achado 25) ----
-- unaccent() nativo é STABLE (depende da config. de dicionário), o que
-- impede seu uso em índice de expressão — por isso o wrapper IMMUTABLE.
CREATE OR REPLACE FUNCTION normalizar_busca(text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path TO 'public', 'extensions' AS $$
  SELECT unaccent('unaccent', lower(regexp_replace(trim($1), '\s+', ' ', 'g')));
$$;

-- Classifica a relevância de p_termo dentro de p_texto_normalizado:
-- 1 exato · 2 início · 3 palavra completa · 4 parcial (substring) ·
-- 5 aproximado (fuzzy, via pg_trgm) · NULL = sem match algum.
-- Múltiplas palavras: cada uma precisa bater (substring ou fuzzy) em
-- algum ponto do texto — ordem digitada não importa.
CREATE OR REPLACE FUNCTION busca_relevancia(p_texto_normalizado text, p_termo text)
RETURNS smallint
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path TO 'public', 'extensions' AS $$
DECLARE
  v_texto text := coalesce(p_texto_normalizado, '');
  v_termo text := normalizar_busca(p_termo);
  v_palavras text[];
  v_palavra text;
  v_todas_ok boolean := true;
  v_alguma_fuzzy boolean := false;
BEGIN
  IF v_termo = '' THEN RETURN NULL; END IF;
  IF v_texto = v_termo THEN RETURN 1; END IF;
  IF v_texto LIKE (v_termo || '%') THEN RETURN 2; END IF;
  IF (' ' || v_texto || ' ') LIKE ('% ' || v_termo || ' %') THEN RETURN 3; END IF;
  IF v_texto LIKE ('%' || v_termo || '%') THEN RETURN 4; END IF;

  v_palavras := regexp_split_to_array(v_termo, '\s+');
  FOREACH v_palavra IN ARRAY v_palavras LOOP
    IF v_palavra = '' THEN CONTINUE; END IF;
    IF v_texto LIKE ('%' || v_palavra || '%') THEN
      CONTINUE;
    ELSIF v_palavra <% v_texto THEN
      v_alguma_fuzzy := true;
      CONTINUE;
    ELSE
      v_todas_ok := false;
      EXIT;
    END IF;
  END LOOP;

  IF NOT v_todas_ok THEN RETURN NULL; END IF;
  IF v_alguma_fuzzy THEN RETURN 5; ELSE RETURN 4; END IF;
END; $$;

-- Listagem paginada + busca por relevância, genérica para as 6 views
-- vw_*_lista — chamada via RPC pela Edge Function no lugar do antigo
-- `.ilike('busca', ...)`. p_view é validada contra uma lista fixa
-- (nunca vem livre do cliente). p_filtro_eq/p_filtro_lte recebem pares
-- coluna→valor já resolvidos pela Edge Function (filtros por tela:
-- status, usuario_id, livro_id, dias_restantes etc.).
CREATE OR REPLACE FUNCTION buscar_pagina(
  p_view text, p_termo text DEFAULT '', p_page int DEFAULT 1, p_page_size int DEFAULT 20,
  p_order_col text DEFAULT NULL, p_order_asc boolean DEFAULT true,
  p_order_col2 text DEFAULT NULL, p_order2_asc boolean DEFAULT true,
  p_filtro_eq jsonb DEFAULT '{}'::jsonb, p_filtro_lte jsonb DEFAULT '{}'::jsonb,
  p_filtro_gte jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE(linha jsonb, total bigint)
LANGUAGE plpgsql STABLE SET search_path TO 'public', 'extensions' AS $$
DECLARE
  v_views_permitidas CONSTANT text[] := ARRAY[
    'vw_usuarios_lista','vw_livros_lista','vw_exemplares_lista',
    'vw_emprestimos_lista','vw_reservas_lista','vw_multas_lista',
    'vw_log_auditoria_lista'
  ];
  v_termo text := normalizar_busca(p_termo);
  v_page int := greatest(coalesce(p_page, 1), 1);
  v_page_size int := least(greatest(coalesce(p_page_size, 20), 1), 100);
  v_offset int := (v_page - 1) * v_page_size;
  v_where text := '';
  v_key text;
  v_sql text;
  v_order_by text := '';
BEGIN
  IF p_view IS NULL OR NOT (p_view = ANY(v_views_permitidas)) THEN
    RAISE EXCEPTION 'view de busca não permitida: %', coalesce(p_view, '(nulo)');
  END IF;

  PERFORM set_config('pg_trgm.word_similarity_threshold', '0.45', true);

  FOR v_key IN SELECT jsonb_object_keys(coalesce(p_filtro_eq, '{}'::jsonb)) LOOP
    v_where := v_where || format(' AND t.%I = %L', v_key, p_filtro_eq ->> v_key);
  END LOOP;
  FOR v_key IN SELECT jsonb_object_keys(coalesce(p_filtro_lte, '{}'::jsonb)) LOOP
    v_where := v_where || format(' AND t.%I <= %L', v_key, p_filtro_lte ->> v_key);
  END LOOP;
  FOR v_key IN SELECT jsonb_object_keys(coalesce(p_filtro_gte, '{}'::jsonb)) LOOP
    v_where := v_where || format(' AND t.%I >= %L', v_key, p_filtro_gte ->> v_key);
  END LOOP;

  IF v_termo <> '' THEN
    v_where := v_where || format(' AND busca_relevancia(normalizar_busca(t.busca), %L) IS NOT NULL', v_termo);
    v_order_by := format(
      'busca_relevancia(normalizar_busca(t.busca), %L) ASC, similarity(normalizar_busca(t.busca), %L) DESC',
      v_termo, v_termo
    );
  END IF;

  IF p_order_col IS NOT NULL THEN
    v_order_by := v_order_by || CASE WHEN v_order_by <> '' THEN ', ' ELSE '' END
      || format('t.%I %s', p_order_col, CASE WHEN p_order_asc THEN 'ASC' ELSE 'DESC' END);
  END IF;
  IF p_order_col2 IS NOT NULL THEN
    v_order_by := v_order_by || CASE WHEN v_order_by <> '' THEN ', ' ELSE '' END
      || format('t.%I %s', p_order_col2, CASE WHEN p_order2_asc THEN 'ASC' ELSE 'DESC' END);
  END IF;
  IF v_order_by = '' THEN v_order_by := 't.busca ASC'; END IF;

  v_sql := format(
    'SELECT to_jsonb(t.*) AS linha, count(*) OVER() AS total FROM %I t WHERE true %s ORDER BY %s LIMIT %L OFFSET %L',
    p_view, v_where, v_order_by, v_page_size, v_offset
  );
  RETURN QUERY EXECUTE v_sql;
END; $$;

-- Só a Edge Function (service_role, já contorna RLS) chama esta função.
REVOKE ALL ON FUNCTION buscar_pagina(text, text, int, int, text, boolean, text, boolean, jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION buscar_pagina(text, text, int, int, text, boolean, text, boolean, jsonb, jsonb, jsonb) TO service_role;

-- Índices GIN trigram nas colunas individuais mais buscadas — aceleram
-- busca/autocomplete futuro por coluna isolada (ex.: autor/editora/
-- categoria). A busca composta multi-campo via `busca` (usada por
-- buscar_pagina) é avaliada em tempo de consulta, não por estes
-- índices — ver nota de limitação na migration 20260714220000.
CREATE INDEX idx_usuario_nome_trgm     ON usuario   USING gin (normalizar_busca(nome) gin_trgm_ops);
CREATE INDEX idx_usuario_email_trgm    ON usuario   USING gin (normalizar_busca(email) gin_trgm_ops);
CREATE INDEX idx_usuario_cpf_trgm      ON usuario   USING gin (normalizar_busca(cpf) gin_trgm_ops);
CREATE INDEX idx_usuario_telefone_trgm ON usuario   USING gin (normalizar_busca(telefone) gin_trgm_ops);
CREATE INDEX idx_livro_titulo_trgm     ON livro     USING gin (normalizar_busca(titulo) gin_trgm_ops);
CREATE INDEX idx_livro_isbn_trgm       ON livro     USING gin (normalizar_busca(isbn) gin_trgm_ops);
CREATE INDEX idx_autor_nome_trgm       ON autor     USING gin (normalizar_busca(nome_autor) gin_trgm_ops);
CREATE INDEX idx_editora_nome_trgm     ON editora   USING gin (normalizar_busca(nome_editora) gin_trgm_ops);
CREATE INDEX idx_categoria_nome_trgm   ON categoria USING gin (normalizar_busca(nome_categoria) gin_trgm_ops);
CREATE INDEX idx_exemplar_codigo_trgm  ON exemplar  USING gin (normalizar_busca(codigo_patrimonial) gin_trgm_ops);

-- ------------------------------------------------------------
-- 5. TRIGGERS
-- ------------------------------------------------------------
CREATE TRIGGER trg_check_exemplar_disponivel BEFORE INSERT ON emprestimo FOR EACH ROW EXECUTE FUNCTION fn_check_exemplar_disponivel();
CREATE TRIGGER trg_emprestimo_insert         AFTER  INSERT ON emprestimo FOR EACH ROW EXECUTE FUNCTION fn_emprestimo_insert();
CREATE TRIGGER trg_emprestimo_update         AFTER  UPDATE ON emprestimo FOR EACH ROW EXECUTE FUNCTION fn_emprestimo_update();
CREATE TRIGGER trg_multa_pagamento           BEFORE UPDATE ON multa      FOR EACH ROW EXECUTE FUNCTION set_multa_pagamento();

CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON autor        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON categoria    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON editora      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON livro        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON livro_autor  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON exemplar     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON usuario      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON emprestimo   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON multa        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON reserva      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON configuracao FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON app_perfil   FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 6. VIEWS (relatórios)
-- ------------------------------------------------------------
CREATE VIEW vw_exemplares_disponiveis WITH (security_invoker = true) AS
SELECT l.titulo, e.codigo_patrimonial, e.status
FROM exemplar e INNER JOIN livro l ON l.livro_id = e.livro_id
WHERE e.status = 'Disponivel'
ORDER BY l.titulo, e.codigo_patrimonial;

CREATE VIEW vw_livros_mais_emprestados WITH (security_invoker = true) AS
SELECT l.titulo, COUNT(em.emprestimo_id) AS totalemprestimos
FROM emprestimo em
INNER JOIN exemplar ex ON ex.exemplar_id = em.exemplar_id
INNER JOIN livro    l  ON l.livro_id     = ex.livro_id
GROUP BY l.titulo ORDER BY totalemprestimos DESC LIMIT 5;

CREATE VIEW vw_emprestimos_em_atraso WITH (security_invoker = true) AS
SELECT em.emprestimo_id, u.nome, u.email, l.titulo, em.data_retirada, em.data_prevista,
    CASE WHEN em.data_devolucao IS NULL THEN CURRENT_DATE - em.data_prevista
         ELSE em.data_devolucao - em.data_prevista END AS dias_atraso,
    COALESCE(mt.valor_total, 0) AS valor_multa
FROM emprestimo em
INNER JOIN usuario  u  ON u.usuario_id   = em.usuario_id
INNER JOIN exemplar ex ON ex.exemplar_id = em.exemplar_id
INNER JOIN livro    l  ON l.livro_id     = ex.livro_id
LEFT  JOIN multa    mt ON mt.emprestimo_id = em.emprestimo_id
WHERE (em.data_devolucao IS NULL AND em.data_prevista < CURRENT_DATE)
   OR (em.data_devolucao IS NOT NULL AND em.data_devolucao > em.data_prevista)
ORDER BY dias_atraso DESC;

CREATE VIEW vw_historico_emprestimos WITH (security_invoker = true) AS
SELECT u.nome, l.titulo, ex.codigo_patrimonial, em.data_retirada, em.data_prevista,
    COALESCE(em.data_devolucao::text, 'Em aberto') AS devolucao,
    COALESCE(mt.valor_total, 0) AS multa
FROM emprestimo em
INNER JOIN usuario  u  ON u.usuario_id   = em.usuario_id
INNER JOIN exemplar ex ON ex.exemplar_id = em.exemplar_id
INNER JOIN livro    l  ON l.livro_id     = ex.livro_id
LEFT  JOIN multa    mt ON mt.emprestimo_id = em.emprestimo_id
ORDER BY u.nome, em.data_retirada DESC;

CREATE VIEW vw_acervo_completo WITH (security_invoker = true) AS
SELECT l.titulo, l.isbn, l.ano_publicacao, ed.nome_editora, cat.nome_categoria,
    COALESCE(STRING_AGG(a.nome_autor, ', '), '(sem autor)') AS autores,
    COUNT(ex.exemplar_id) AS totalexemplares,
    SUM(CASE WHEN ex.status = 'Disponivel' THEN 1 ELSE 0 END) AS disponiveis
FROM livro l
INNER JOIN editora   ed  ON ed.editora_id    = l.editora_id
INNER JOIN categoria cat ON cat.categoria_id = l.categoria_id
LEFT  JOIN livro_autor la ON la.livro_id     = l.livro_id
LEFT  JOIN autor     a   ON a.autor_id       = la.autor_id
LEFT  JOIN exemplar  ex  ON ex.livro_id      = l.livro_id
GROUP BY l.titulo, l.isbn, l.ano_publicacao, ed.nome_editora, cat.nome_categoria
ORDER BY l.titulo;

CREATE VIEW vw_reservas_ativas WITH (security_invoker = true) AS
SELECT l.titulo, u.nome AS usuarioreserva, r.data_reserva, r.status,
    ROW_NUMBER() OVER (PARTITION BY r.livro_id ORDER BY r.data_reserva) AS posicaofila
FROM reserva r
INNER JOIN usuario u ON u.usuario_id = r.usuario_id
INNER JOIN livro   l ON l.livro_id   = r.livro_id
WHERE r.status = 'Ativa'
ORDER BY l.titulo, posicaofila;

CREATE VIEW vw_receita_multas_mensal WITH (security_invoker = true) AS
SELECT EXTRACT(YEAR FROM em.data_devolucao) AS ano, EXTRACT(MONTH FROM em.data_devolucao) AS mes,
    COUNT(mt.multa_id) AS qtdmultas, SUM(mt.valor_total) AS receitatotal,
    SUM(CASE WHEN mt.pago THEN mt.valor_total ELSE 0 END) AS receitarecebida
FROM multa mt INNER JOIN emprestimo em ON em.emprestimo_id = mt.emprestimo_id
WHERE em.data_devolucao IS NOT NULL
GROUP BY EXTRACT(YEAR FROM em.data_devolucao), EXTRACT(MONTH FROM em.data_devolucao)
ORDER BY ano, mes;

-- ------------------------------------------------------------
-- 6b. VIEWS DE LISTAS PAGINADAS (consumidas pela API; coluna `busca`)
-- ------------------------------------------------------------
CREATE VIEW vw_usuarios_lista WITH (security_invoker = true) AS
SELECT u.usuario_id, u.nome, u.email, u.cpf, u.telefone, u.ativo,
  lower(coalesce(u.nome,'')||' '||coalesce(u.email,'')||' '||coalesce(u.cpf,'')||' '||coalesce(u.telefone,'')) AS busca
FROM usuario u;

-- reservas_ativas adicionado em 16/07/2026 (migration
-- 20260716010000_reservas_ativas_livros_lista.sql) — indicador de reservas
-- na lista de Livros, pedido no feedback de design. emprestados adicionado
-- em 17/07/2026 (migration 20260717020000_exemplares_feedback3.sql) — a
-- tela de Livros mostra "N disponível(is) · M emprestado(s)" sem precisar
-- abrir o Detalhe do Livro. Ambos vão ao final da lista de colunas (depois
-- de `busca`) porque CREATE OR REPLACE VIEW não permite reposicionar
-- colunas existentes, só acrescentar no fim.
CREATE VIEW vw_livros_lista WITH (security_invoker = true) AS
SELECT l.livro_id, l.titulo, l.isbn, l.ano_publicacao, cat.nome_categoria, ed.nome_editora,
  COALESCE(string_agg(DISTINCT a.nome_autor, ', '), '') AS autores,
  COUNT(DISTINCT ex.exemplar_id) AS total_ex,
  COUNT(DISTINCT ex.exemplar_id) FILTER (WHERE ex.status = 'Disponivel') AS disp,
  lower(coalesce(l.titulo,'')||' '||coalesce(l.isbn,'')||' '||coalesce(string_agg(DISTINCT a.nome_autor,' '),'')||' '||coalesce(l.ano_publicacao::text,'')||' '||coalesce(cat.nome_categoria,'')||' '||coalesce(ed.nome_editora,'')) AS busca,
  COUNT(DISTINCT r.reserva_id) FILTER (WHERE r.status = 'Ativa') AS reservas_ativas,
  COUNT(DISTINCT ex.exemplar_id) FILTER (WHERE ex.status = 'Emprestado') AS emprestados
FROM livro l
INNER JOIN editora   ed  ON ed.editora_id    = l.editora_id
INNER JOIN categoria cat ON cat.categoria_id = l.categoria_id
LEFT  JOIN livro_autor la ON la.livro_id     = l.livro_id
LEFT  JOIN autor       a  ON a.autor_id       = la.autor_id
LEFT  JOIN exemplar    ex ON ex.livro_id      = l.livro_id
LEFT  JOIN reserva     r  ON r.livro_id       = l.livro_id
GROUP BY l.livro_id, l.titulo, l.isbn, l.ano_publicacao, cat.nome_categoria, ed.nome_editora;

-- usuario_nome/data_prevista/created_at adicionados em 16/07/2026 (migration
-- 20260716020000_exemplares_reforma.sql) — reforma da tela de Exemplares: mostrar quem
-- está com o exemplar emprestado e a data de cadastro. Vão ao final da lista de colunas
-- (depois de `busca`), mesma razão da migration de reservas_ativas em vw_livros_lista.
-- busca inclui o nome do leitor com o exemplar emprestado desde 17/07/2026
-- (migration 20260717010000_exemplares_feedback2.sql) — feedback de que a
-- busca da tela de Exemplares deveria encontrar também pelo leitor.
-- motivo_baixa/usuario_id/atrasado/dias_atraso/reservas_ativas adicionados em
-- 17/07/2026 (migration 20260717020000_exemplares_feedback3.sql) — permitem
-- filtrar por leitor, mostrar "Motivo: X" já na listagem e diferenciar
-- "Emprestado" (no prazo) de "Atrasado" (prazo vencido) sem lógica de data
-- no cliente (mesmo padrão de vw_emprestimos_lista.situacao/dias_atraso).
CREATE VIEW vw_exemplares_lista WITH (security_invoker = true) AS
SELECT e.exemplar_id, e.codigo_patrimonial, e.status, e.livro_id, l.titulo,
  lower(coalesce(e.codigo_patrimonial,'')||' '||coalesce(e.status,'')||' '||coalesce(l.titulo,'')||' '||coalesce(u.nome,'')) AS busca,
  u.nome AS usuario_nome, em.data_prevista, e.created_at,
  e.motivo_baixa, u.usuario_id,
  (em.data_prevista IS NOT NULL AND em.data_prevista < CURRENT_DATE) AS atrasado,
  CASE WHEN em.data_prevista IS NOT NULL AND em.data_prevista < CURRENT_DATE
       THEN (CURRENT_DATE - em.data_prevista) END AS dias_atraso,
  (SELECT COUNT(*) FROM reserva r WHERE r.livro_id = e.livro_id AND r.status = 'Ativa') AS reservas_ativas,
  e.updated_at
FROM exemplar e
INNER JOIN livro l ON l.livro_id = e.livro_id
LEFT JOIN emprestimo em ON em.exemplar_id = e.exemplar_id AND em.data_devolucao IS NULL
LEFT JOIN usuario u ON u.usuario_id = em.usuario_id;

CREATE VIEW vw_emprestimos_lista WITH (security_invoker = true) AS
SELECT
  em.emprestimo_id, u.nome AS usuario_nome, l.titulo AS livro_titulo, ex.codigo_patrimonial,
  em.data_retirada, em.data_prevista, em.data_devolucao,
  CASE WHEN em.data_devolucao IS NOT NULL THEN 'Devolvido'
       WHEN em.data_prevista < CURRENT_DATE THEN 'Atrasado' ELSE 'Ativo' END AS situacao,
  lower(coalesce(u.nome,'')||' '||coalesce(l.titulo,'')||' '||coalesce(ex.codigo_patrimonial,'')||' '||coalesce(em.data_retirada::text,'')||' '||coalesce(em.data_prevista::text,'')||' '||coalesce(em.data_devolucao::text,'')) AS busca,
  -- Colunas adicionadas em 20260714210000_emprestimos_lista_filtros_e_dias.sql
  -- (redesenho da tela de Empréstimos: filtros por leitor/livro + dias restantes/atraso).
  em.usuario_id, l.livro_id, em.exemplar_id,
  CASE WHEN em.data_devolucao IS NULL AND em.data_prevista < CURRENT_DATE
       THEN (CURRENT_DATE - em.data_prevista) END AS dias_atraso,
  CASE WHEN em.data_devolucao IS NULL AND em.data_prevista >= CURRENT_DATE
       THEN (em.data_prevista - CURRENT_DATE) END AS dias_restantes
FROM emprestimo em
INNER JOIN usuario  u  ON u.usuario_id   = em.usuario_id
INNER JOIN exemplar ex ON ex.exemplar_id = em.exemplar_id
INNER JOIN livro    l  ON l.livro_id     = ex.livro_id;

CREATE VIEW vw_reservas_lista WITH (security_invoker = true) AS
SELECT r.reserva_id, u.nome AS usuario_nome, l.titulo AS livro_titulo, r.livro_id, r.data_reserva, r.status,
  CASE WHEN r.status = 'Ativa' THEN (
    SELECT count(*) FROM reserva r2
    WHERE r2.livro_id = r.livro_id AND r2.status = 'Ativa'
      AND (r2.data_reserva, r2.reserva_id) <= (r.data_reserva, r.reserva_id)
  ) END AS fila,
  lower(coalesce(u.nome,'')||' '||coalesce(l.titulo,'')||' '||coalesce(r.status,'')||' '||coalesce(r.data_reserva::text,'')) AS busca
FROM reserva r
INNER JOIN usuario u ON u.usuario_id = r.usuario_id
INNER JOIN livro   l ON l.livro_id   = r.livro_id;

CREATE VIEW vw_multas_lista WITH (security_invoker = true) AS
SELECT m.multa_id, u.nome AS usuario_nome, l.titulo AS livro_titulo, m.valor_dia, m.pago,
  (em.data_devolucao IS NULL) AS aberto,
  CASE WHEN em.data_devolucao IS NULL THEN GREATEST(0, CURRENT_DATE - em.data_prevista) ELSE m.dias_atraso END AS dias,
  CASE WHEN em.data_devolucao IS NULL THEN GREATEST(0, CURRENT_DATE - em.data_prevista)::numeric * m.valor_dia ELSE m.valor_total END AS total,
  lower(coalesce(u.nome,'')||' '||coalesce(l.titulo,'')||' '||CASE WHEN m.pago THEN 'pago' ELSE 'pendente' END) AS busca
FROM multa m
INNER JOIN emprestimo em ON em.emprestimo_id = m.emprestimo_id
INNER JOIN usuario    u  ON u.usuario_id     = em.usuario_id
INNER JOIN exemplar   ex ON ex.exemplar_id   = em.exemplar_id
INNER JOIN livro      l  ON l.livro_id       = ex.livro_id;

-- Página Auditoria (16/07/2026) — ver migration 20260716000000_auditoria_pagina.sql.
CREATE VIEW vw_log_auditoria_lista WITH (security_invoker = true) AS
SELECT
  l.id, l.usuario_email, l.acao, l.entidade, l.registro_id, l.detalhe, l.criado_em,
  lower(coalesce(l.usuario_email,'')||' '||coalesce(l.acao,'')||' '||coalesce(l.entidade,'')||' '||coalesce(l.registro_id,'')) AS busca
FROM log_auditoria l;

-- Só a Edge Function (service_role) lê as views — ver seção 7b.
GRANT SELECT ON vw_usuarios_lista, vw_livros_lista, vw_exemplares_lista,
                vw_emprestimos_lista, vw_reservas_lista, vw_multas_lista,
                vw_log_auditoria_lista
TO service_role;

-- ------------------------------------------------------------
-- 7. RLS — Row Level Security (leitura: qualquer autenticado;
--    escrita: exige papel admin/bibliotecario via papel_atual()).
--    A API (Edge Function) usa a chave de serviço e ignora o RLS;
--    esta camada é o que impede a escrita direta via REST/PostgREST
--    por uma conta de papel 'consulta' contornando a Edge Function.
-- ------------------------------------------------------------
DO $$
DECLARE t text;
  tbls text[] := ARRAY['autor','categoria','configuracao','editora','emprestimo','exemplar','livro','livro_autor','multa','reserva','usuario'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', t||'_sel_auth', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.papel_atual() IN (''admin'',''bibliotecario''))', t||'_ins_auth', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.papel_atual() IN (''admin'',''bibliotecario'')) WITH CHECK (public.papel_atual() IN (''admin'',''bibliotecario''))', t||'_upd_auth', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.papel_atual() IN (''admin'',''bibliotecario''))', t||'_del_auth', t);
  END LOOP;
END $$;

ALTER TABLE public.log_auditoria ENABLE ROW LEVEL SECURITY;
CREATE POLICY log_sel_auth ON public.log_auditoria FOR SELECT TO authenticated USING (true);

ALTER TABLE public.log_erro ENABLE ROW LEVEL SECURITY;
CREATE POLICY log_erro_sel_auth ON public.log_erro FOR SELECT TO authenticated USING (true);

ALTER TABLE public.app_perfil ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_perfil_sel_own ON public.app_perfil FOR SELECT TO authenticated USING (user_id = (select auth.uid()));

-- ------------------------------------------------------------
-- 7b. PRIVILÉGIOS — sem acesso direto via PostgREST (/rest/v1)
--     (migration 20260930120000_revogar_acesso_direto_postgrest.sql).
--     O front só fala com a Edge Function `api` (service_role); anon e
--     authenticated não têm privilégio algum em tabelas/views/sequences.
--     As policies de RLS acima ficam como segunda camada de defesa.
-- ------------------------------------------------------------
REVOKE ALL ON TABLE
  public.autor, public.categoria, public.configuracao, public.editora,
  public.emprestimo, public.exemplar, public.livro, public.livro_autor,
  public.multa, public.reserva, public.usuario,
  public.log_auditoria, public.log_erro, public.app_perfil
FROM anon, authenticated;

REVOKE ALL ON TABLE
  public.vw_usuarios_lista, public.vw_livros_lista, public.vw_exemplares_lista,
  public.vw_emprestimos_lista, public.vw_reservas_lista, public.vw_multas_lista,
  public.vw_log_auditoria_lista,
  public.vw_exemplares_disponiveis, public.vw_livros_mais_emprestados,
  public.vw_emprestimos_em_atraso, public.vw_historico_emprestimos,
  public.vw_acervo_completo, public.vw_reservas_ativas, public.vw_receita_multas_mensal
FROM anon, authenticated;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ------------------------------------------------------------
-- 8. SEED
-- ------------------------------------------------------------
INSERT INTO configuracao (chave, valor_numerico, descricao)
VALUES ('valor_dia_multa', 2.00, 'Valor em reais cobrado por dia de atraso na devolucao')
ON CONFLICT (chave) DO NOTHING;

INSERT INTO app_perfil (email, papel) VALUES ('adminlume@lume.local', 'admin')
ON CONFLICT (email) DO NOTHING;
