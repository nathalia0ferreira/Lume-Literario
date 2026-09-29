-- ============================================================
-- Segunda rodada de feedback sobre a tela de Exemplares (17/07/2026,
-- mesma sessão da criação rápida de Categoria/Editora/Autor). Dois
-- ajustes de banco:
--
-- 1. Busca de Exemplares passa a encontrar também pelo nome do leitor
--    que está com o exemplar emprestado no momento (ex.: digitar
--    "Carla" encontra o exemplar EX0011 que está emprestado a ela).
--    A view já trazia usuario_nome desde a reforma de 16/07
--    (20260716020000_exemplares_reforma.sql) — só não fazia parte da
--    coluna `busca` usada por buscar_pagina().
-- 2. Nova função proximo_codigo_patrimonial(): permite ao front-end
--    mostrar uma prévia do próximo código ("Código previsto: EX0013")
--    no modal "Novo Exemplar", em vez do texto genérico "gerado
--    automaticamente". É só uma prévia (espia last_value/is_called da
--    sequence sem avançá-la) — não é uma reserva; se dois cadastros
--    concorrentes acontecerem ao mesmo tempo, o código efetivo de um
--    deles pode divergir da prévia mostrada. Aceitável na escala de
--    uma biblioteca (cadastro de exemplar não é uma operação de alta
--    concorrência).
-- ============================================================

CREATE OR REPLACE VIEW vw_exemplares_lista WITH (security_invoker = true) AS
SELECT e.exemplar_id, e.codigo_patrimonial, e.status, e.livro_id, l.titulo,
  lower(coalesce(e.codigo_patrimonial,'')||' '||coalesce(e.status,'')||' '||coalesce(l.titulo,'')||' '||coalesce(u.nome,'')) AS busca,
  u.nome AS usuario_nome, em.data_prevista, e.created_at
FROM exemplar e
INNER JOIN livro l ON l.livro_id = e.livro_id
LEFT JOIN emprestimo em ON em.exemplar_id = e.exemplar_id AND em.data_devolucao IS NULL
LEFT JOIN usuario u ON u.usuario_id = em.usuario_id;

CREATE OR REPLACE FUNCTION public.proximo_codigo_patrimonial()
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT 'EX' || lpad((last_value + CASE WHEN is_called THEN 1 ELSE 0 END)::text, 4, '0')
  FROM seq_exemplar_codigo;
$$;

-- Mesma fronteira de confiança das demais funções de suporte (buscar_pagina
-- etc.): só a Edge Function (service_role) chama.
REVOKE ALL ON FUNCTION public.proximo_codigo_patrimonial() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.proximo_codigo_patrimonial() TO service_role;
