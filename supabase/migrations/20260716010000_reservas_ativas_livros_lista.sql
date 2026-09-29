-- ============================================================
-- Indicador de reservas na lista de Livros (16/07/2026).
-- Feedback de design: "hoje o usuário só descobre [as reservas] nos
-- detalhes... na tabela poderia existir uma pequena informação" — uma das
-- 3 prioridades da "principal recomendação" do pedido.
--
-- Adiciona reservas_ativas a vw_livros_lista via LEFT JOIN + COUNT(DISTINCT
-- ... FILTER). Seguro mesmo com o LEFT JOIN existente em exemplar: como
-- total_ex/disp já usam COUNT(DISTINCT ex.exemplar_id), o fan-out de linhas
-- causado pelo novo JOIN em reserva não infla essas contagens — e
-- reservas_ativas usa o mesmo padrão (COUNT(DISTINCT r.reserva_id) FILTER)
-- para não ser inflado pelo fan-out de exemplar/autor.
--
-- A nova coluna vai ao FINAL da lista de SELECT (depois de `busca`), não
-- entre `disp` e `busca` como seria mais "natural" — CREATE OR REPLACE VIEW
-- não permite mudar a posição/nome de colunas existentes, só acrescentar no
-- fim (Postgres erro 42P16 na primeira tentativa).
-- ============================================================

CREATE OR REPLACE VIEW vw_livros_lista WITH (security_invoker = true) AS
SELECT l.livro_id, l.titulo, l.isbn, l.ano_publicacao, cat.nome_categoria, ed.nome_editora,
  COALESCE(string_agg(DISTINCT a.nome_autor, ', '), '') AS autores,
  COUNT(DISTINCT ex.exemplar_id) AS total_ex,
  COUNT(DISTINCT ex.exemplar_id) FILTER (WHERE ex.status = 'Disponivel') AS disp,
  lower(coalesce(l.titulo,'')||' '||coalesce(l.isbn,'')||' '||coalesce(string_agg(DISTINCT a.nome_autor,' '),'')||' '||coalesce(l.ano_publicacao::text,'')||' '||coalesce(cat.nome_categoria,'')||' '||coalesce(ed.nome_editora,'')) AS busca,
  COUNT(DISTINCT r.reserva_id) FILTER (WHERE r.status = 'Ativa') AS reservas_ativas
FROM livro l
INNER JOIN editora   ed  ON ed.editora_id    = l.editora_id
INNER JOIN categoria cat ON cat.categoria_id = l.categoria_id
LEFT  JOIN livro_autor la ON la.livro_id     = l.livro_id
LEFT  JOIN autor       a  ON a.autor_id       = la.autor_id
LEFT  JOIN exemplar    ex ON ex.livro_id      = l.livro_id
LEFT  JOIN reserva     r  ON r.livro_id       = l.livro_id
GROUP BY l.livro_id, l.titulo, l.isbn, l.ano_publicacao, cat.nome_categoria, ed.nome_editora;
