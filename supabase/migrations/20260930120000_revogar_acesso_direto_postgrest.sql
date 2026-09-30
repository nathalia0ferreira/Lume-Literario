-- ============================================================
--  Lume Literário — fecha o acesso direto às tabelas/views via
--  PostgREST (/rest/v1) para os papéis anon e authenticated.
--  (Análise de segurança 30/09/2026, achado C1)
--
--  Problema: as policies de SELECT das tabelas de domínio, de
--  log_auditoria e de log_erro eram `TO authenticated USING (true)`.
--  Com o cadastro público do Supabase Auth aberto, qualquer pessoa
--  podia criar uma conta com a chave anon (pública no front) e ler
--  direto pelo REST todos os leitores (nome, CPF, e-mail, telefone),
--  a auditoria e os erros — sem passar pela Edge Function nem pelo
--  RBAC. Bibliotecários também conseguiam escrever direto nas
--  tabelas, pulando as regras de negócio e a trilha de auditoria.
--
--  Correção: o front não usa PostgREST para dados (só a Edge
--  Function `api`, que roda como service_role). Então os privilégios
--  de tabela/view de anon e authenticated são removidos por completo.
--  O RLS continua ligado como segunda camada. service_role não é
--  afetado (a Edge Function segue funcionando igual).
-- ============================================================

-- Tabelas
REVOKE ALL ON TABLE
  public.autor, public.categoria, public.configuracao, public.editora,
  public.emprestimo, public.exemplar, public.livro, public.livro_autor,
  public.multa, public.reserva, public.usuario,
  public.log_auditoria, public.log_erro, public.app_perfil
FROM anon, authenticated;

-- Views (listas paginadas e relatórios)
REVOKE ALL ON TABLE
  public.vw_usuarios_lista, public.vw_livros_lista, public.vw_exemplares_lista,
  public.vw_emprestimos_lista, public.vw_reservas_lista, public.vw_multas_lista,
  public.vw_log_auditoria_lista,
  public.vw_exemplares_disponiveis, public.vw_livros_mais_emprestados,
  public.vw_emprestimos_em_atraso, public.vw_historico_emprestimos,
  public.vw_acervo_completo, public.vw_reservas_ativas, public.vw_receita_multas_mensal
FROM anon, authenticated;

-- Sequences (códigos patrimoniais e identities)
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- Objetos criados no futuro por migrations também não ficam expostos por padrão.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- Garante explicitamente que a Edge Function (service_role) mantém acesso.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
