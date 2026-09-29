/* ============================================================
   AUTH — autenticação via Supabase Auth (camada de serviço).
   Login de equipe: digite "adminlume" (o domínio é completado).
   ============================================================ */
const AUTH_DOMINIO = '@lume.local';

function traduzErroAuth(e) {
  const m = (e && e.message) || '';
  if (/invalid login/i.test(m)) return 'Usuário ou senha inválidos.';
  if (/email not confirmed/i.test(m)) return 'E-mail não confirmado.';
  if (/rate/i.test(m)) return 'Muitas tentativas. Aguarde alguns instantes.';
  return m || 'Falha ao entrar.';
}

const AuthService = {
  async sessao() {
    const { data } = await sb.auth.getSession();
    return data.session;
  },
  async usuarioAtual() {
    const { data } = await sb.auth.getUser();
    return data.user;
  },
  async entrar(usuario, senha) {
    if (!usuario || !senha) return { ok: false, message: 'Informe usuário e senha.' };
    const email = usuario.includes('@') ? usuario : usuario + AUTH_DOMINIO;
    const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
    return error ? { ok: false, message: traduzErroAuth(error) } : { ok: true, email: data.user.email };
  },
  async sair() {
    await sb.auth.signOut();
  },
  // Reautentica o usuário logado (confirma a senha atual antes de uma troca de senha).
  async reautenticar(email, senhaAtual) {
    const { error } = await sb.auth.signInWithPassword({ email, password: senhaAtual });
    return { ok: !error, message: error ? traduzErroAuth(error) : null };
  },
  // Troca a senha do usuário já autenticado.
  async alterarSenha(novaSenha) {
    const { error } = await sb.auth.updateUser({ password: novaSenha });
    return { ok: !error, message: error ? error.message : null };
  },
};
