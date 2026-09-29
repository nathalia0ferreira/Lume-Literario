-- ============================================================
-- Terceira rodada de feedback sobre a tela de Exemplares (17/07/2026):
-- design da tabela/badges/filtros. Duas views atualizadas:
--
-- 1. vw_exemplares_lista ganha:
--    - motivo_baixa (já existia na tabela, não estava na view — precisava
--      para mostrar "Motivo: X" na própria listagem, não só no detalhe).
--    - usuario_id (id do leitor com o exemplar emprestado no momento) —
--      permite filtrar a lista por leitor ("quais livros a Carla está com").
--    - atrasado (boolean) e dias_atraso — calculados no banco (mesmo padrão
--      já usado em vw_emprestimos_lista), para a tela poder diferenciar
--      visualmente "Emprestado" (dentro do prazo) de "Atrasado" (prazo
--      vencido) sem precisar de lógica de data no cliente.
--    - reservas_ativas — quantas reservas ativas existem para o livro deste
--      exemplar (subquery correlacionada, mesmo padrão de vw_reservas_lista.fila),
--      para sinalizar fila de espera direto na listagem.
--
-- 2. vw_livros_lista ganha `emprestados` (contagem análoga a `disp`), para
--    a tela de Livros poder mostrar "N disponível(is) · M emprestado(s)"
--    sem precisar abrir o Detalhe do Livro.
-- ============================================================

CREATE OR REPLACE VIEW vw_exemplares_lista WITH (security_invoker = true) AS
SELECT e.exemplar_id, e.codigo_patrimonial, e.status, e.livro_id, l.titulo,
  lower(coalesce(e.codigo_patrimonial,'')||' '||coalesce(e.status,'')||' '||coalesce(l.titulo,'')||' '||coalesce(u.nome,'')) AS busca,
  u.nome AS usuario_nome, em.data_prevista, e.created_at,
  e.motivo_baixa, u.usuario_id,
  (em.data_prevista IS NOT NULL AND em.data_prevista < CURRENT_DATE) AS atrasado,
  CASE WHEN em.data_prevista IS NOT NULL AND em.data_prevista < CURRENT_DATE
       THEN (CURRENT_DATE - em.data_prevista) END AS dias_atraso,
  (SELECT COUNT(*) FROM reserva r WHERE r.livro_id = e.livro_id AND r.status = 'Ativa') AS reservas_ativas
FROM exemplar e
INNER JOIN livro l ON l.livro_id = e.livro_id
LEFT JOIN emprestimo em ON em.exemplar_id = e.exemplar_id AND em.data_devolucao IS NULL
LEFT JOIN usuario u ON u.usuario_id = em.usuario_id;

CREATE OR REPLACE VIEW vw_livros_lista WITH (security_invoker = true) AS
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
