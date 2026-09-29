-- rls_auto_enable() é a função da plataforma Supabase que liga o RLS
-- automaticamente em tabelas novas (event trigger "ensure_rls").
-- Ela não precisa ser chamável pela API (/rest/v1/rpc), então removemos
-- a permissão de execução dos papéis públicos. O event trigger continua
-- funcionando normalmente.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
