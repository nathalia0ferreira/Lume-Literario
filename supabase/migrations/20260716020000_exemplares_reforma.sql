-- ============================================================
-- Reforma da tela de Exemplares (16/07/2026).
-- Pedido de design: transformar cadastro em modal, remover UUID da UI,
-- destacar código patrimonial, status coloridos (+ novo status
-- Manutenção), menu de ações no lugar do select inline, filtros de
-- status/livro, indicador de quem está com o exemplar, e tela de
-- detalhe com histórico completo (empréstimos/reservas/mudanças de
-- status/baixa). Escopo autorizado pelo usuário: "Tudo" + adicionar
-- Manutenção ao banco agora + gerar código automaticamente agora.
--
-- Este arquivo cobre as 4 mudanças de banco:
--  1. Novo status 'Manutencao' no CHECK de exemplar.status.
--  2. Coluna motivo_baixa (Perda/Extravio/Danificado/Descartado/Outro),
--     nullable — obrigatoriedade quando status='Baixado' é validada na
--     Edge Function (não em CHECK, para não travar os 2 registros
--     Baixado já existentes sem motivo; eles são preenchidos como
--     'Outro' abaixo, já que o motivo real não foi registrado no
--     passado).
--  3. Geração automática de codigo_patrimonial via sequence + função
--     DEFAULT, preservando o padrão EX0001.. já usado manualmente
--     (sequence começa em 13 — os 12 códigos existentes vão de
--     EX0001 a EX0012, sem lacunas).
--  4. vw_exemplares_lista ganha usuario_nome/data_prevista (para
--     mostrar quem está com o exemplar emprestado) e created_at (data
--     de cadastro). Colunas vão ao FINAL da lista de SELECT, depois de
--     `busca` — CREATE OR REPLACE VIEW não permite reposicionar
--     colunas existentes (ver lição da migration
--     20260716010000_reservas_ativas_livros_lista.sql).
-- ============================================================

-- ---- 1. Novo status Manutencao ----
ALTER TABLE exemplar DROP CONSTRAINT chk_exemplar_status;
ALTER TABLE exemplar ADD CONSTRAINT chk_exemplar_status
  CHECK (status IN ('Disponivel','Emprestado','Reservado','Baixado','Manutencao'));

-- ---- 2. motivo_baixa ----
ALTER TABLE exemplar ADD COLUMN motivo_baixa varchar(20);
ALTER TABLE exemplar ADD CONSTRAINT chk_motivo_baixa
  CHECK (motivo_baixa IS NULL OR motivo_baixa IN ('Perda','Extravio','Danificado','Descartado','Outro'));
UPDATE exemplar SET motivo_baixa = 'Outro' WHERE status = 'Baixado' AND motivo_baixa IS NULL;

-- ---- 3. Código patrimonial automático ----
CREATE SEQUENCE seq_exemplar_codigo START WITH 13;
ALTER SEQUENCE seq_exemplar_codigo OWNED BY exemplar.codigo_patrimonial;

CREATE OR REPLACE FUNCTION public.gerar_codigo_patrimonial()
RETURNS text LANGUAGE sql SET search_path TO 'public' AS $$
  SELECT 'EX' || lpad(nextval('seq_exemplar_codigo')::text, 4, '0');
$$;

ALTER TABLE exemplar ALTER COLUMN codigo_patrimonial SET DEFAULT gerar_codigo_patrimonial();

-- ---- 4. vw_exemplares_lista: quem está com o exemplar + data de cadastro ----
CREATE OR REPLACE VIEW vw_exemplares_lista WITH (security_invoker = true) AS
SELECT e.exemplar_id, e.codigo_patrimonial, e.status, e.livro_id, l.titulo,
  lower(coalesce(e.codigo_patrimonial,'')||' '||coalesce(e.status,'')||' '||coalesce(l.titulo,'')) AS busca,
  u.nome AS usuario_nome, em.data_prevista, e.created_at
FROM exemplar e
INNER JOIN livro l ON l.livro_id = e.livro_id
LEFT JOIN emprestimo em ON em.exemplar_id = e.exemplar_id AND em.data_devolucao IS NULL
LEFT JOIN usuario u ON u.usuario_id = em.usuario_id;
