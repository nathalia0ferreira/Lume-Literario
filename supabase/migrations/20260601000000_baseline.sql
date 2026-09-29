-- ============================================================
--  Lume Literário — BASELINE do banco (migration inicial)
--  Reproduz toda a estrutura a partir do zero: tabelas, FKs,
--  índices, funções/triggers/procedure, views de relatório,
--  RLS/políticas e seed.
--  Espelha db/schema.sql (seção canônica legível). As views de
--  LISTAS PAGINADAS vêm na migration 20260613000000_listas_paginadas.sql.
-- ============================================================

-- ------------------------------------------------------------
-- 1. TABELAS
-- ------------------------------------------------------------
CREATE TABLE autor (
    autorid       SERIAL PRIMARY KEY,
    nomeautor     varchar(100) NOT NULL,
    nacionalidade varchar(50),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE categoria (
    categoriaid   SERIAL PRIMARY KEY,
    nomecategoria varchar(60) NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE editora (
    editoraid   SERIAL PRIMARY KEY,
    nomeeditora varchar(100) NOT NULL,
    cidade      varchar(80),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE livro (
    livroid       SERIAL PRIMARY KEY,
    titulo        varchar(200) NOT NULL,
    isbn          varchar(20)  NOT NULL UNIQUE,
    anopublicacao smallint,
    editoraid     integer NOT NULL,
    categoriaid   integer NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE livro_autor (
    livroid    integer NOT NULL,
    autorid    integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (livroid, autorid)
);

CREATE TABLE exemplar (
    exemplarid        SERIAL PRIMARY KEY,
    codigopatrimonial varchar(20) NOT NULL UNIQUE,
    livroid           integer NOT NULL,
    status            varchar(20) NOT NULL DEFAULT 'Disponivel',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_exemplar_status CHECK (status IN ('Disponivel','Emprestado','Reservado','Baixado'))
);

CREATE TABLE usuario (
    usuarioid    SERIAL PRIMARY KEY,
    nome         varchar(100) NOT NULL,
    email        varchar(100) NOT NULL UNIQUE,
    cpf          varchar(11)  NOT NULL UNIQUE,
    telefone     varchar(20),
    datacadastro date    NOT NULL DEFAULT CURRENT_DATE,
    ativo        boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_cpf_format CHECK (cpf ~ '^\d{11}$')
);

CREATE TABLE emprestimo (
    emprestimoid  SERIAL PRIMARY KEY,
    usuarioid     integer NOT NULL,
    exemplarid    integer NOT NULL,
    dataretirada  date NOT NULL DEFAULT CURRENT_DATE,
    dataprevista  date NOT NULL,
    datadevolucao date,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_datas CHECK (dataprevista >= dataretirada)
);

CREATE TABLE multa (
    multaid        SERIAL PRIMARY KEY,
    emprestimoid   integer NOT NULL UNIQUE,
    diasatraso     integer NOT NULL,
    valordia       numeric(6,2) NOT NULL DEFAULT 2.00,
    pago           boolean NOT NULL DEFAULT false,
    valortotal     numeric(10,2) GENERATED ALWAYS AS (diasatraso::numeric * valordia) STORED,
    data_pagamento timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_diasatraso_positivo CHECK (diasatraso >= 0)
);

CREATE TABLE reserva (
    reservaid   SERIAL PRIMARY KEY,
    usuarioid   integer NOT NULL,
    livroid     integer NOT NULL,
    datareserva date NOT NULL DEFAULT CURRENT_DATE,
    status      varchar(20) NOT NULL DEFAULT 'Ativa',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_reserva_status CHECK (status IN ('Ativa','Atendida','Cancelada'))
);

CREATE TABLE configuracao (
    chave          varchar(50) PRIMARY KEY,
    valor_numerico numeric(10,2),
    descricao      text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE log_auditoria (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usuario_email text,
    acao          text NOT NULL,
    entidade      text,
    registro_id   text,
    detalhe       jsonb,
    criado_em     timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 2. CHAVES ESTRANGEIRAS
-- ------------------------------------------------------------
ALTER TABLE livro       ADD CONSTRAINT livro_editoraid_fkey       FOREIGN KEY (editoraid)    REFERENCES editora(editoraid)     ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE livro       ADD CONSTRAINT livro_categoriaid_fkey     FOREIGN KEY (categoriaid)  REFERENCES categoria(categoriaid) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE livro_autor ADD CONSTRAINT livro_autor_livroid_fkey  FOREIGN KEY (livroid)      REFERENCES livro(livroid)         ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE livro_autor ADD CONSTRAINT livro_autor_autorid_fkey  FOREIGN KEY (autorid)      REFERENCES autor(autorid)         ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE exemplar    ADD CONSTRAINT exemplar_livroid_fkey      FOREIGN KEY (livroid)      REFERENCES livro(livroid)         ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE emprestimo  ADD CONSTRAINT emprestimo_usuarioid_fkey  FOREIGN KEY (usuarioid)    REFERENCES usuario(usuarioid)     ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE emprestimo  ADD CONSTRAINT emprestimo_exemplarid_fkey FOREIGN KEY (exemplarid)   REFERENCES exemplar(exemplarid)   ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE multa       ADD CONSTRAINT multa_emprestimoid_fkey    FOREIGN KEY (emprestimoid) REFERENCES emprestimo(emprestimoid) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE reserva     ADD CONSTRAINT reserva_usuarioid_fkey     FOREIGN KEY (usuarioid)    REFERENCES usuario(usuarioid)     ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE reserva     ADD CONSTRAINT reserva_livroid_fkey       FOREIGN KEY (livroid)      REFERENCES livro(livroid)         ON UPDATE CASCADE ON DELETE CASCADE;

-- ------------------------------------------------------------
-- 3. ÍNDICES
-- ------------------------------------------------------------
CREATE INDEX idx_livro_editoraid          ON livro(editoraid);
CREATE INDEX idx_livro_categoriaid        ON livro(categoriaid);
CREATE INDEX idx_livro_autor_autorid      ON livro_autor(autorid);
CREATE INDEX idx_exemplar_livroid         ON exemplar(livroid);
CREATE INDEX idx_exemplar_status          ON exemplar(status);
CREATE INDEX idx_emprestimo_usuarioid     ON emprestimo(usuarioid);
CREATE INDEX idx_emprestimo_exemplarid    ON emprestimo(exemplarid);
CREATE INDEX idx_emprestimo_dataprevista  ON emprestimo(dataprevista);
CREATE INDEX idx_emprestimo_datadevolucao ON emprestimo(datadevolucao);
CREATE INDEX idx_multa_pago               ON multa(pago);
CREATE INDEX idx_reserva_usuarioid        ON reserva(usuarioid);
CREATE INDEX idx_reserva_livroid          ON reserva(livroid);
CREATE INDEX idx_reserva_status           ON reserva(status);
CREATE INDEX idx_usuario_ativo            ON usuario(ativo);
CREATE INDEX idx_log_criado_em            ON log_auditoria(criado_em DESC);

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
  UPDATE exemplar SET status = 'Emprestado' WHERE exemplarid = NEW.exemplarid;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.fn_emprestimo_update()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF OLD.datadevolucao IS NULL AND NEW.datadevolucao IS NOT NULL THEN
    UPDATE exemplar SET status = 'Disponivel' WHERE exemplarid = NEW.exemplarid;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.fn_check_exemplar_disponivel()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE
  v_status        TEXT;
  v_usuario_ativo BOOLEAN;
BEGIN
  SELECT ativo INTO v_usuario_ativo FROM usuario WHERE usuarioid = NEW.usuarioid;
  IF NOT v_usuario_ativo THEN
    RAISE EXCEPTION 'Usuário % está inativo e não pode realizar empréstimos.', NEW.usuarioid;
  END IF;

  SELECT status INTO v_status FROM exemplar WHERE exemplarid = NEW.exemplarid FOR UPDATE;
  IF v_status <> 'Disponivel' THEN
    RAISE EXCEPTION 'Exemplar % não está disponível para empréstimo (status atual: %).', NEW.exemplarid, v_status;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE PROCEDURE public.registrar_devolucao(IN p_emprestimoid integer)
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE
  v_dataprevista DATE;
  v_diasatraso   INT;
  v_multaexiste  BOOLEAN;
  v_valordia     NUMERIC(10,2);
  v_livroid      INT;
  v_reserva_id   INT;
BEGIN
  SELECT COALESCE((SELECT valor_numerico FROM configuracao WHERE chave = 'valor_dia_multa'), 2.00)
  INTO v_valordia;

  SELECT dataprevista INTO v_dataprevista
  FROM emprestimo WHERE emprestimoid = p_emprestimoid AND datadevolucao IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Empréstimo % não encontrado ou já devolvido.', p_emprestimoid;
  END IF;

  UPDATE emprestimo SET datadevolucao = CURRENT_DATE WHERE emprestimoid = p_emprestimoid;

  v_diasatraso := GREATEST(0, CURRENT_DATE - v_dataprevista);
  IF v_diasatraso > 0 THEN
    SELECT EXISTS(SELECT 1 FROM multa WHERE emprestimoid = p_emprestimoid) INTO v_multaexiste;
    IF NOT v_multaexiste THEN
      INSERT INTO multa(emprestimoid, diasatraso, valordia, pago)
      VALUES (p_emprestimoid, v_diasatraso, v_valordia, FALSE);
    END IF;
  END IF;

  SELECT ex.livroid INTO v_livroid
  FROM emprestimo em JOIN exemplar ex ON ex.exemplarid = em.exemplarid
  WHERE em.emprestimoid = p_emprestimoid;

  SELECT reservaid INTO v_reserva_id
  FROM reserva WHERE livroid = v_livroid AND status = 'Ativa'
  ORDER BY datareserva ASC LIMIT 1;

  IF FOUND THEN
    UPDATE reserva SET status = 'Atendida' WHERE reservaid = v_reserva_id;
  END IF;
END; $$;

CREATE OR REPLACE FUNCTION public.dashboard_stats()
RETURNS json LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT json_build_object(
    'usuarios',          (SELECT count(*) FROM usuario WHERE ativo),
    'livros',            (SELECT count(*) FROM livro),
    'exemplares',        (SELECT count(*) FROM exemplar),
    'emprestimosAtivos', (SELECT count(*) FROM emprestimo WHERE datadevolucao IS NULL)
  );
$$;

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

-- ------------------------------------------------------------
-- 6. VIEWS (relatórios)
-- ------------------------------------------------------------
CREATE VIEW vw_exemplares_disponiveis WITH (security_invoker = true) AS
SELECT l.titulo, e.codigopatrimonial, e.status
FROM exemplar e INNER JOIN livro l ON l.livroid = e.livroid
WHERE e.status = 'Disponivel'
ORDER BY l.titulo, e.codigopatrimonial;

CREATE VIEW vw_livros_mais_emprestados WITH (security_invoker = true) AS
SELECT l.titulo, COUNT(em.emprestimoid) AS totalemprestimos
FROM emprestimo em
INNER JOIN exemplar ex ON ex.exemplarid = em.exemplarid
INNER JOIN livro    l  ON l.livroid     = ex.livroid
GROUP BY l.titulo ORDER BY totalemprestimos DESC LIMIT 5;

CREATE VIEW vw_emprestimos_em_atraso WITH (security_invoker = true) AS
SELECT em.emprestimoid, u.nome, u.email, l.titulo, em.dataretirada, em.dataprevista,
    CASE WHEN em.datadevolucao IS NULL THEN CURRENT_DATE - em.dataprevista
         ELSE em.datadevolucao - em.dataprevista END AS diasatraso,
    COALESCE(mt.valortotal, 0) AS valormulta
FROM emprestimo em
INNER JOIN usuario  u  ON u.usuarioid   = em.usuarioid
INNER JOIN exemplar ex ON ex.exemplarid = em.exemplarid
INNER JOIN livro    l  ON l.livroid     = ex.livroid
LEFT  JOIN multa    mt ON mt.emprestimoid = em.emprestimoid
WHERE (em.datadevolucao IS NULL AND em.dataprevista < CURRENT_DATE)
   OR (em.datadevolucao IS NOT NULL AND em.datadevolucao > em.dataprevista)
ORDER BY diasatraso DESC;

CREATE VIEW vw_historico_emprestimos WITH (security_invoker = true) AS
SELECT u.nome, l.titulo, ex.codigopatrimonial, em.dataretirada, em.dataprevista,
    COALESCE(em.datadevolucao::text, 'Em aberto') AS devolucao,
    COALESCE(mt.valortotal, 0) AS multa
FROM emprestimo em
INNER JOIN usuario  u  ON u.usuarioid   = em.usuarioid
INNER JOIN exemplar ex ON ex.exemplarid = em.exemplarid
INNER JOIN livro    l  ON l.livroid     = ex.livroid
LEFT  JOIN multa    mt ON mt.emprestimoid = em.emprestimoid
ORDER BY u.nome, em.dataretirada DESC;

CREATE VIEW vw_acervo_completo WITH (security_invoker = true) AS
SELECT l.titulo, l.isbn, l.anopublicacao, ed.nomeeditora, cat.nomecategoria,
    COALESCE(STRING_AGG(a.nomeautor, ', '), '(sem autor)') AS autores,
    COUNT(ex.exemplarid) AS totalexemplares,
    SUM(CASE WHEN ex.status = 'Disponivel' THEN 1 ELSE 0 END) AS disponiveis
FROM livro l
INNER JOIN editora   ed  ON ed.editoraid    = l.editoraid
INNER JOIN categoria cat ON cat.categoriaid = l.categoriaid
LEFT  JOIN livro_autor la ON la.livroid     = l.livroid
LEFT  JOIN autor     a   ON a.autorid       = la.autorid
LEFT  JOIN exemplar  ex  ON ex.livroid      = l.livroid
GROUP BY l.titulo, l.isbn, l.anopublicacao, ed.nomeeditora, cat.nomecategoria
ORDER BY l.titulo;

CREATE VIEW vw_reservas_ativas WITH (security_invoker = true) AS
SELECT l.titulo, u.nome AS usuarioreserva, r.datareserva, r.status,
    ROW_NUMBER() OVER (PARTITION BY r.livroid ORDER BY r.datareserva) AS posicaofila
FROM reserva r
INNER JOIN usuario u ON u.usuarioid = r.usuarioid
INNER JOIN livro   l ON l.livroid   = r.livroid
WHERE r.status = 'Ativa'
ORDER BY l.titulo, posicaofila;

CREATE VIEW vw_receita_multas_mensal WITH (security_invoker = true) AS
SELECT EXTRACT(YEAR FROM em.datadevolucao) AS ano, EXTRACT(MONTH FROM em.datadevolucao) AS mes,
    COUNT(mt.multaid) AS qtdmultas, SUM(mt.valortotal) AS receitatotal,
    SUM(CASE WHEN mt.pago THEN mt.valortotal ELSE 0 END) AS receitarecebida
FROM multa mt INNER JOIN emprestimo em ON em.emprestimoid = mt.emprestimoid
WHERE em.datadevolucao IS NOT NULL
GROUP BY EXTRACT(YEAR FROM em.datadevolucao), EXTRACT(MONTH FROM em.datadevolucao)
ORDER BY ano, mes;

-- ------------------------------------------------------------
-- 7. RLS — Row Level Security (somente usuários autenticados)
-- ------------------------------------------------------------
DO $$
DECLARE t text;
  tbls text[] := ARRAY['autor','categoria','configuracao','editora','emprestimo','exemplar','livro','livro_autor','multa','reserva','usuario'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', t||'_sel_auth', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL)', t||'_ins_auth', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL)', t||'_upd_auth', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (auth.uid() IS NOT NULL)', t||'_del_auth', t);
  END LOOP;
END $$;

ALTER TABLE public.log_auditoria ENABLE ROW LEVEL SECURITY;
CREATE POLICY log_sel_auth ON public.log_auditoria FOR SELECT TO authenticated USING (true);

-- ------------------------------------------------------------
-- 8. SEED
-- ------------------------------------------------------------
INSERT INTO configuracao (chave, valor_numerico, descricao)
VALUES ('valor_dia_multa', 2.00, 'Valor em reais cobrado por dia de atraso na devolucao')
ON CONFLICT (chave) DO NOTHING;
