-- ============================================================
--  Lume Literário — RBAC (perfis de acesso) + OBSERVABILIDADE
--  SEG-2: papéis admin / bibliotecario / leitor vinculados ao
--         usuário de autenticação (Supabase Auth).
--  D2:    tabela log_erro para rastreamento de exceções da API.
--  O enforcement (quem pode o quê) é feito na Edge Function `api`,
--  que roda com service_role. Estas tabelas são a fonte de verdade.
-- ============================================================

-- ---------- Perfis de acesso (RBAC) ----------
CREATE TABLE IF NOT EXISTS public.app_perfil (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid UNIQUE,                 -- = auth.users.id (preenchido no 1º login)
  email      text UNIQUE,                 -- bootstrap por e-mail antes do 1º login
  papel      text NOT NULL DEFAULT 'leitor',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_papel CHECK (papel IN ('admin','bibliotecario','leitor'))
);

CREATE INDEX IF NOT EXISTS idx_app_perfil_email ON public.app_perfil(email);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.app_perfil;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.app_perfil
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS: a API (service_role) faz tudo; um usuário só pode LER o próprio papel.
ALTER TABLE public.app_perfil ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_perfil_sel_own ON public.app_perfil;
CREATE POLICY app_perfil_sel_own ON public.app_perfil
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Bootstrap do primeiro administrador (vincula o user_id no 1º login).
-- Ajuste o e-mail se o seu admin for outro.
INSERT INTO public.app_perfil (email, papel)
VALUES ('adminlume@lume.local', 'admin')
ON CONFLICT (email) DO NOTHING;

-- ---------- Rastreamento de erros (observabilidade) ----------
CREATE TABLE IF NOT EXISTS public.log_erro (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  acao          text,
  usuario_email text,
  mensagem      text NOT NULL,
  detalhe       jsonb,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_log_erro_criado_em ON public.log_erro(criado_em DESC);

ALTER TABLE public.log_erro ENABLE ROW LEVEL SECURITY;
-- Leitura por autenticados; escrita somente pela API/service_role (sem policy de INSERT).
DROP POLICY IF EXISTS log_erro_sel_auth ON public.log_erro;
CREATE POLICY log_erro_sel_auth ON public.log_erro
  FOR SELECT TO authenticated USING (true);
