-- ============================================================
--  Lume Literário — recria a policy de SELECT de app_perfil
--  (Auditoria 13/07/2026, complemento ao Achado 1)
--
--  Ao aplicar 20260713000000_rls_rbac_enforcement.sql em produção
--  e checar os Advisors de segurança do Supabase, foi encontrado que
--  `app_perfil` tinha RLS ativado mas NENHUMA política — resultado:
--  papel_atual() sempre retornava NULL para quem chamasse via REST
--  direto (authenticated), pois a leitura da própria linha em
--  app_perfil era bloqueada por padrão pelo RLS sem policy.
--
--  A aplicação em si não era afetada (a Edge Function usa
--  service_role, que ignora RLS), mas a policy documentada em
--  db/schema.sql e na migration 20260613010000 não estava de fato
--  aplicada neste projeto. Esta migration a recria.
-- ============================================================
DROP POLICY IF EXISTS app_perfil_sel_own ON public.app_perfil;
CREATE POLICY app_perfil_sel_own ON public.app_perfil
  FOR SELECT TO authenticated USING (user_id = auth.uid());
