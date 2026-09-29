-- ============================================================
--  Lume Literário — RLS: enforcement do RBAC nas tabelas de domínio
--  (Auditoria 13/07/2026, Achado 1)
--
--  Problema: as políticas de escrita (INSERT/UPDATE/DELETE) das 11
--  tabelas de domínio exigiam só "usuário autenticado"
--  (auth.uid() IS NOT NULL), sem checar o papel em app_perfil.
--  Isso permitia que um usuário com papel 'leitor' escrevesse
--  diretamente via API REST do Supabase (PostgREST), contornando
--  o bloqueio que a Edge Function `api` já aplicava corretamente
--  (ACOES_ESCRITA + papel === 'leitor' -> 403).
--
--  Correção: escrita nas tabelas de domínio passa a exigir
--  papel_atual() IN ('admin','bibliotecario') na própria RLS.
--  Leitura (SELECT) não muda — qualquer autenticado, inclusive
--  'leitor', continua podendo ler.
-- ============================================================

-- Papel do usuário logado, lido da própria linha em app_perfil
-- (permitido pela policy app_perfil_sel_own: user_id = auth.uid()).
-- Sem SECURITY DEFINER: roda com o mesmo direito de quem chama.
CREATE OR REPLACE FUNCTION public.papel_atual()
RETURNS text LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT papel FROM app_perfil WHERE user_id = auth.uid()
$$;

COMMENT ON FUNCTION public.papel_atual() IS
  'Papel RBAC (admin/bibliotecario/leitor) do usuário autenticado atual; usado nas políticas de RLS de escrita.';

-- Recria as políticas de escrita das 11 tabelas de domínio exigindo
-- papel admin/bibliotecario. Mesmos nomes de policy de sempre
-- (drop + create, para rodar de forma idempotente em re-execução).
DO $$
DECLARE t text;
  tbls text[] := ARRAY['autor','categoria','configuracao','editora','emprestimo','exemplar','livro','livro_autor','multa','reserva','usuario'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_ins_auth', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_upd_auth', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_del_auth', t);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.papel_atual() IN (''admin'',''bibliotecario''))',
      t||'_ins_auth', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.papel_atual() IN (''admin'',''bibliotecario'')) WITH CHECK (public.papel_atual() IN (''admin'',''bibliotecario''))',
      t||'_upd_auth', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.papel_atual() IN (''admin'',''bibliotecario''))',
      t||'_del_auth', t);
  END LOOP;
END $$;

-- Nota: 'leitor' recém-criado só ganha linha em app_perfil no 1º
-- login (auto-provisionado como 'leitor' pela Edge Function). Até lá,
-- papel_atual() retorna NULL e as políticas de escrita bloqueiam por
-- padrão (fail-closed) — comportamento correto.
