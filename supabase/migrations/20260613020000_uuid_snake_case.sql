-- ============================================================
--  Lume Literário — B6: UUID + snake_case (PRESERVANDO DADOS)
--  Converte as PKs sequenciais (SERIAL) das tabelas de domínio
--  para UUID e renomeia colunas/identificadores para snake_case.
--
--  ⚠️  MIGRAÇÃO DESTRUTIVA/IRREVERSÍVEL. Roda em transação única:
--      se qualquer passo falhar, o Postgres faz ROLLBACK atômico.
--      VALIDAR EM STAGING (e com backup/PITR) ANTES da produção.
--
--  Estratégia (sem perda): para cada tabela com PK serial cria-se
--  uma coluna uuid; os FKs ganham coluna uuid populada por JOIN no
--  ID antigo; trocam-se PKs/FKs; renomeiam-se colunas; recriam-se
--  índices, funções, triggers e views já em snake_case/UUID.
--  Tabelas internas de log (log_auditoria, log_erro) e app_perfil
--  mantêm seus ids bigint/uuid próprios.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1. Remover dependentes (views) — serão recriadas no fim
-- ------------------------------------------------------------
DROP VIEW IF EXISTS
  vw_usuarios_lista, vw_livros_lista, vw_exemplares_lista, vw_emprestimos_lista,
  vw_reservas_lista, vw_multas_lista, vw_exemplares_disponiveis, vw_livros_mais_emprestados,
  vw_emprestimos_em_atraso, vw_historico_emprestimos, vw_acervo_completo,
  vw_reservas_ativas, vw_receita_multas_mensal CASCADE;

-- ------------------------------------------------------------
-- 2. Remover as FKs (serão recriadas em uuid)
-- ------------------------------------------------------------
ALTER TABLE livro       DROP CONSTRAINT livro_editoraid_fkey;
ALTER TABLE livro       DROP CONSTRAINT livro_categoriaid_fkey;
ALTER TABLE livro_autor DROP CONSTRAINT livro_autor_livroid_fkey;
ALTER TABLE livro_autor DROP CONSTRAINT livro_autor_autorid_fkey;
ALTER TABLE exemplar    DROP CONSTRAINT exemplar_livroid_fkey;
ALTER TABLE emprestimo  DROP CONSTRAINT emprestimo_usuarioid_fkey;
ALTER TABLE emprestimo  DROP CONSTRAINT emprestimo_exemplarid_fkey;
ALTER TABLE multa       DROP CONSTRAINT multa_emprestimoid_fkey;
ALTER TABLE reserva     DROP CONSTRAINT reserva_usuarioid_fkey;
ALTER TABLE reserva     DROP CONSTRAINT reserva_livroid_fkey;

-- ------------------------------------------------------------
-- 3. Coluna uuid nas tabelas com PK serial
-- ------------------------------------------------------------
ALTER TABLE autor      ADD COLUMN uuid_new uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE categoria  ADD COLUMN uuid_new uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE editora    ADD COLUMN uuid_new uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE usuario    ADD COLUMN uuid_new uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE livro      ADD COLUMN uuid_new uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE exemplar   ADD COLUMN uuid_new uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE emprestimo ADD COLUMN uuid_new uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE multa      ADD COLUMN uuid_new uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE reserva    ADD COLUMN uuid_new uuid NOT NULL DEFAULT gen_random_uuid();

-- ------------------------------------------------------------
-- 4. Colunas uuid de FK nos filhos + popular por JOIN no ID antigo
-- ------------------------------------------------------------
ALTER TABLE livro ADD COLUMN editora_uuid uuid, ADD COLUMN categoria_uuid uuid;
UPDATE livro l SET editora_uuid   = e.uuid_new FROM editora   e WHERE l.editoraid   = e.editoraid;
UPDATE livro l SET categoria_uuid = c.uuid_new FROM categoria c WHERE l.categoriaid = c.categoriaid;

ALTER TABLE livro_autor ADD COLUMN livro_uuid uuid, ADD COLUMN autor_uuid uuid;
UPDATE livro_autor la SET livro_uuid = l.uuid_new FROM livro l WHERE la.livroid = l.livroid;
UPDATE livro_autor la SET autor_uuid = a.uuid_new FROM autor a WHERE la.autorid = a.autorid;

ALTER TABLE exemplar ADD COLUMN livro_uuid uuid;
UPDATE exemplar ex SET livro_uuid = l.uuid_new FROM livro l WHERE ex.livroid = l.livroid;

ALTER TABLE emprestimo ADD COLUMN usuario_uuid uuid, ADD COLUMN exemplar_uuid uuid;
UPDATE emprestimo em SET usuario_uuid  = u.uuid_new  FROM usuario  u  WHERE em.usuarioid  = u.usuarioid;
UPDATE emprestimo em SET exemplar_uuid = ex.uuid_new FROM exemplar ex WHERE em.exemplarid = ex.exemplarid;

ALTER TABLE multa ADD COLUMN emprestimo_uuid uuid;
UPDATE multa m SET emprestimo_uuid = em.uuid_new FROM emprestimo em WHERE m.emprestimoid = em.emprestimoid;

ALTER TABLE reserva ADD COLUMN usuario_uuid uuid, ADD COLUMN livro_uuid uuid;
UPDATE reserva r SET usuario_uuid = u.uuid_new FROM usuario u WHERE r.usuarioid = u.usuarioid;
UPDATE reserva r SET livro_uuid   = l.uuid_new FROM livro   l WHERE r.livroid   = l.livroid;

-- ------------------------------------------------------------
-- 5. Remover PKs antigas e colunas int (PK e FK)
-- ------------------------------------------------------------
ALTER TABLE livro_autor DROP CONSTRAINT livro_autor_pkey;
ALTER TABLE autor      DROP CONSTRAINT autor_pkey;
ALTER TABLE categoria  DROP CONSTRAINT categoria_pkey;
ALTER TABLE editora    DROP CONSTRAINT editora_pkey;
ALTER TABLE usuario    DROP CONSTRAINT usuario_pkey;
ALTER TABLE livro      DROP CONSTRAINT livro_pkey;
ALTER TABLE exemplar   DROP CONSTRAINT exemplar_pkey;
ALTER TABLE emprestimo DROP CONSTRAINT emprestimo_pkey;
ALTER TABLE multa      DROP CONSTRAINT multa_pkey;
ALTER TABLE reserva    DROP CONSTRAINT reserva_pkey;

ALTER TABLE livro       DROP COLUMN editoraid, DROP COLUMN categoriaid;
ALTER TABLE livro_autor DROP COLUMN livroid,   DROP COLUMN autorid;
ALTER TABLE exemplar    DROP COLUMN livroid;
ALTER TABLE emprestimo  DROP COLUMN usuarioid, DROP COLUMN exemplarid;
ALTER TABLE multa       DROP COLUMN emprestimoid;
ALTER TABLE reserva     DROP COLUMN usuarioid, DROP COLUMN livroid;

ALTER TABLE autor      DROP COLUMN autorid;
ALTER TABLE categoria  DROP COLUMN categoriaid;
ALTER TABLE editora    DROP COLUMN editoraid;
ALTER TABLE usuario    DROP COLUMN usuarioid;
ALTER TABLE livro      DROP COLUMN livroid;
ALTER TABLE exemplar   DROP COLUMN exemplarid;
ALTER TABLE emprestimo DROP COLUMN emprestimoid;
ALTER TABLE multa      DROP COLUMN multaid;
ALTER TABLE reserva    DROP COLUMN reservaid;

-- ------------------------------------------------------------
-- 6. Promover uuid -> PK e renomear FKs (snake_case)
-- ------------------------------------------------------------
ALTER TABLE autor     RENAME COLUMN uuid_new TO autor_id;
ALTER TABLE autor     ADD CONSTRAINT autor_pkey PRIMARY KEY (autor_id);
ALTER TABLE categoria RENAME COLUMN uuid_new TO categoria_id;
ALTER TABLE categoria ADD CONSTRAINT categoria_pkey PRIMARY KEY (categoria_id);
ALTER TABLE editora   RENAME COLUMN uuid_new TO editora_id;
ALTER TABLE editora   ADD CONSTRAINT editora_pkey PRIMARY KEY (editora_id);
ALTER TABLE usuario   RENAME COLUMN uuid_new TO usuario_id;
ALTER TABLE usuario   ADD CONSTRAINT usuario_pkey PRIMARY KEY (usuario_id);

ALTER TABLE livro RENAME COLUMN uuid_new TO livro_id;
ALTER TABLE livro ADD CONSTRAINT livro_pkey PRIMARY KEY (livro_id);
ALTER TABLE livro RENAME COLUMN editora_uuid   TO editora_id;
ALTER TABLE livro RENAME COLUMN categoria_uuid TO categoria_id;
ALTER TABLE livro ALTER COLUMN editora_id   SET NOT NULL;
ALTER TABLE livro ALTER COLUMN categoria_id SET NOT NULL;

ALTER TABLE exemplar RENAME COLUMN uuid_new TO exemplar_id;
ALTER TABLE exemplar ADD CONSTRAINT exemplar_pkey PRIMARY KEY (exemplar_id);
ALTER TABLE exemplar RENAME COLUMN livro_uuid TO livro_id;
ALTER TABLE exemplar ALTER COLUMN livro_id SET NOT NULL;

ALTER TABLE livro_autor RENAME COLUMN livro_uuid TO livro_id;
ALTER TABLE livro_autor RENAME COLUMN autor_uuid TO autor_id;
ALTER TABLE livro_autor ALTER COLUMN livro_id SET NOT NULL;
ALTER TABLE livro_autor ALTER COLUMN autor_id SET NOT NULL;
ALTER TABLE livro_autor ADD CONSTRAINT livro_autor_pkey PRIMARY KEY (livro_id, autor_id);

ALTER TABLE emprestimo RENAME COLUMN uuid_new TO emprestimo_id;
ALTER TABLE emprestimo ADD CONSTRAINT emprestimo_pkey PRIMARY KEY (emprestimo_id);
ALTER TABLE emprestimo RENAME COLUMN usuario_uuid  TO usuario_id;
ALTER TABLE emprestimo RENAME COLUMN exemplar_uuid TO exemplar_id;
ALTER TABLE emprestimo ALTER COLUMN usuario_id  SET NOT NULL;
ALTER TABLE emprestimo ALTER COLUMN exemplar_id SET NOT NULL;

ALTER TABLE multa RENAME COLUMN uuid_new TO multa_id;
ALTER TABLE multa ADD CONSTRAINT multa_pkey PRIMARY KEY (multa_id);
ALTER TABLE multa RENAME COLUMN emprestimo_uuid TO emprestimo_id;
ALTER TABLE multa ALTER COLUMN emprestimo_id SET NOT NULL;
ALTER TABLE multa ADD CONSTRAINT multa_emprestimo_id_key UNIQUE (emprestimo_id);

ALTER TABLE reserva RENAME COLUMN uuid_new TO reserva_id;
ALTER TABLE reserva ADD CONSTRAINT reserva_pkey PRIMARY KEY (reserva_id);
ALTER TABLE reserva RENAME COLUMN usuario_uuid TO usuario_id;
ALTER TABLE reserva RENAME COLUMN livro_uuid   TO livro_id;
ALTER TABLE reserva ALTER COLUMN usuario_id SET NOT NULL;
ALTER TABLE reserva ALTER COLUMN livro_id   SET NOT NULL;

-- ------------------------------------------------------------
-- 7. Renomear demais colunas para snake_case
-- ------------------------------------------------------------
ALTER TABLE usuario    RENAME COLUMN datacadastro      TO data_cadastro;
ALTER TABLE categoria  RENAME COLUMN nomecategoria     TO nome_categoria;
ALTER TABLE editora    RENAME COLUMN nomeeditora       TO nome_editora;
ALTER TABLE autor      RENAME COLUMN nomeautor         TO nome_autor;
ALTER TABLE livro      RENAME COLUMN anopublicacao     TO ano_publicacao;
ALTER TABLE exemplar   RENAME COLUMN codigopatrimonial TO codigo_patrimonial;
ALTER TABLE emprestimo RENAME COLUMN dataretirada      TO data_retirada;
ALTER TABLE emprestimo RENAME COLUMN dataprevista      TO data_prevista;
ALTER TABLE emprestimo RENAME COLUMN datadevolucao     TO data_devolucao;
ALTER TABLE multa      RENAME COLUMN diasatraso        TO dias_atraso;
ALTER TABLE multa      RENAME COLUMN valordia          TO valor_dia;
ALTER TABLE multa      RENAME COLUMN valortotal        TO valor_total;
ALTER TABLE reserva    RENAME COLUMN datareserva       TO data_reserva;

-- Renomear constraints CHECK (cosmético, mantém nomes coerentes)
ALTER TABLE emprestimo RENAME CONSTRAINT ck_datas TO chk_datas;

-- ------------------------------------------------------------
-- 8. Recriar índices removidos junto com as colunas int
-- ------------------------------------------------------------
CREATE INDEX idx_livro_editora_id        ON livro(editora_id);
CREATE INDEX idx_livro_categoria_id      ON livro(categoria_id);
CREATE INDEX idx_livro_autor_autor_id    ON livro_autor(autor_id);
CREATE INDEX idx_exemplar_livro_id       ON exemplar(livro_id);
CREATE INDEX idx_emprestimo_usuario_id   ON emprestimo(usuario_id);
CREATE INDEX idx_emprestimo_exemplar_id  ON emprestimo(exemplar_id);
CREATE INDEX idx_reserva_usuario_id      ON reserva(usuario_id);
CREATE INDEX idx_reserva_livro_id        ON reserva(livro_id);

-- ------------------------------------------------------------
-- 9. Recriar funções/procedure/triggers em snake_case
-- ------------------------------------------------------------
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
    'usuarios',          (SELECT count(*) FROM usuario WHERE ativo),
    'livros',            (SELECT count(*) FROM livro),
    'exemplares',        (SELECT count(*) FROM exemplar),
    'emprestimosAtivos', (SELECT count(*) FROM emprestimo WHERE data_devolucao IS NULL)
  );
$$;

-- ------------------------------------------------------------
-- 10. Recriar VIEWS de relatório (snake_case)
-- ------------------------------------------------------------
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
-- 11. Recriar VIEWS de listas paginadas (snake_case)
-- ------------------------------------------------------------
CREATE VIEW vw_usuarios_lista WITH (security_invoker = true) AS
SELECT u.usuario_id, u.nome, u.email, u.cpf, u.telefone, u.ativo,
  lower(coalesce(u.nome,'')||' '||coalesce(u.email,'')||' '||coalesce(u.cpf,'')||' '||coalesce(u.telefone,'')) AS busca
FROM usuario u;

CREATE VIEW vw_livros_lista WITH (security_invoker = true) AS
SELECT l.livro_id, l.titulo, l.isbn, l.ano_publicacao, cat.nome_categoria, ed.nome_editora,
  COALESCE(string_agg(DISTINCT a.nome_autor, ', '), '') AS autores,
  COUNT(DISTINCT ex.exemplar_id) AS total_ex,
  COUNT(DISTINCT ex.exemplar_id) FILTER (WHERE ex.status = 'Disponivel') AS disp,
  lower(coalesce(l.titulo,'')||' '||coalesce(l.isbn,'')||' '||coalesce(string_agg(DISTINCT a.nome_autor,' '),'')||' '||coalesce(l.ano_publicacao::text,'')||' '||coalesce(cat.nome_categoria,'')||' '||coalesce(ed.nome_editora,'')) AS busca
FROM livro l
INNER JOIN editora   ed  ON ed.editora_id    = l.editora_id
INNER JOIN categoria cat ON cat.categoria_id = l.categoria_id
LEFT  JOIN livro_autor la ON la.livro_id     = l.livro_id
LEFT  JOIN autor       a  ON a.autor_id       = la.autor_id
LEFT  JOIN exemplar    ex ON ex.livro_id      = l.livro_id
GROUP BY l.livro_id, l.titulo, l.isbn, l.ano_publicacao, cat.nome_categoria, ed.nome_editora;

CREATE VIEW vw_exemplares_lista WITH (security_invoker = true) AS
SELECT e.exemplar_id, e.codigo_patrimonial, e.status, e.livro_id, l.titulo,
  lower(coalesce(e.codigo_patrimonial,'')||' '||coalesce(e.status,'')||' '||coalesce(l.titulo,'')) AS busca
FROM exemplar e INNER JOIN livro l ON l.livro_id = e.livro_id;

CREATE VIEW vw_emprestimos_lista WITH (security_invoker = true) AS
SELECT em.emprestimo_id, u.nome AS usuario_nome, l.titulo AS livro_titulo, ex.codigo_patrimonial,
  em.data_retirada, em.data_prevista, em.data_devolucao,
  CASE WHEN em.data_devolucao IS NOT NULL THEN 'Devolvido'
       WHEN em.data_prevista < CURRENT_DATE THEN 'Atrasado' ELSE 'Ativo' END AS situacao,
  lower(coalesce(u.nome,'')||' '||coalesce(l.titulo,'')||' '||coalesce(ex.codigo_patrimonial,'')||' '||coalesce(em.data_retirada::text,'')||' '||coalesce(em.data_prevista::text,'')||' '||coalesce(em.data_devolucao::text,'')) AS busca
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

GRANT SELECT ON vw_usuarios_lista, vw_livros_lista, vw_exemplares_lista,
                vw_emprestimos_lista, vw_reservas_lista, vw_multas_lista
TO authenticated, service_role;
