-- ============================================================
--  Correções pós-migration B6 (uuid_snake_case), aplicadas ao vivo em
--  produção em 13/07/2026 e retroativamente registradas aqui para manter
--  supabase/migrations/ e db/schema.sql como fonte de verdade (Achado 11
--  da auditoria técnica 13/07/2026).
-- ============================================================

-- 1. categorias_com_livros() ficou de fora da recriação em snake_case da
--    migration 20260613020000_uuid_snake_case.sql e continuava referenciando
--    colunas antigas (nomecategoria, categoriaid, livroid) — toda chamada
--    falhava com "column does not exist". Era a causa raiz do painel geral
--    aparecer sem dados (reportado pelo usuário em 13/07/2026). Também
--    adiciona SET search_path (Advisor de segurança).
CREATE OR REPLACE FUNCTION public.categorias_com_livros()
RETURNS TABLE(nome text, total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
SELECT c.nome_categoria AS nome, COUNT(l.livro_id) AS total
FROM public.categoria c
LEFT JOIN public.livro l ON l.categoria_id = c.categoria_id
GROUP BY c.nome_categoria
ORDER BY total DESC;
$$;

-- 2. Remove o overload antigo (int) de registrar_devolucao, deixado para trás
--    quando a migration 20260613020000 criou o overload novo (uuid) via
--    CREATE OR REPLACE — como os tipos de parâmetro diferem, o Postgres
--    manteve os dois como procedures distintas. O overload antigo referenciava
--    colunas que não existem mais e não é mais alcançável pelo app (que chama
--    com o parâmetro nomeado p_emprestimo_id), mas ficava como código morto
--    e quebrado no banco.
DROP PROCEDURE IF EXISTS public.registrar_devolucao(integer);

-- 3. Item de performance do Advisor (auth_rls_initplan): app_perfil_sel_own
--    reavaliava auth.uid() por linha. Troca por (select auth.uid()).
DROP POLICY IF EXISTS app_perfil_sel_own ON public.app_perfil;
CREATE POLICY app_perfil_sel_own ON public.app_perfil
  FOR SELECT
  USING (user_id = (select auth.uid()));
