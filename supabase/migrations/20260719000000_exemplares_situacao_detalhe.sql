-- ============================================================
-- Quarta rodada de feedback sobre a tela de Exemplares (19/07/2026):
-- "Situação" (badge) e "Detalhe" (texto contextual) viraram duas colunas
-- separadas — hoje a tabela mostra "Atrasado" como se fosse um status do
-- exemplar, mas fisicamente o exemplar continua "Emprestado"; quem está
-- atrasado é o empréstimo. O badge de Situação vai passar a refletir só o
-- estado físico real (Disponível/Emprestado/Manutenção/Baixado); o atraso e
-- outras informações contextuais migram para a nova coluna Detalhe.
--
-- vw_exemplares_lista ganha `updated_at` (a coluna já existe em `exemplar`,
-- mantida pelo trigger trg_set_updated_at em toda alteração de status) —
-- usada para compor "Baixado em {data}"/"Em manutenção desde {data}" na
-- coluna Detalhe. Como o único UPDATE que a aplicação faz em `exemplar` é
-- a troca de status (exemplarAtualizarStatus), updated_at funciona como uma
-- data de "última alteração de status" sem precisar de uma coluna dedicada.
-- ============================================================

-- updated_at entra no FINAL da lista de colunas (não junto de created_at) —
-- CREATE OR REPLACE VIEW não permite inserir uma coluna no meio da lista
-- (o Postgres interpreta como "renomear" a coluna seguinte); só é possível
-- adicionar ao final ou usar ALTER VIEW ... RENAME COLUMN.
CREATE OR REPLACE VIEW vw_exemplares_lista WITH (security_invoker = true) AS
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
