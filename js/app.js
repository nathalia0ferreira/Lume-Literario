/* ============================================================
   APP — inicialização, gate de autenticação e eventos globais.
   ============================================================ */

// Sidebar: abre/fecha no mobile
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('collapsed');
}

// User menu dropdown
function toggleUserMenu() {
  const btn = document.querySelector('.user-menu-btn');
  const dd = document.getElementById('userDropdown');
  const open = dd.classList.toggle('open');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
document.addEventListener('click', (e) => {
  if (!document.getElementById('userMenu')?.contains(e.target)) {
    document.getElementById('userDropdown')?.classList.remove('open');
    document.querySelector('.user-menu-btn')?.setAttribute('aria-expanded', 'false');
  }
  if (!e.target.closest('.action-menu-wrap')) {
    document.querySelectorAll('.action-menu.open').forEach((m) => m.classList.remove('open'));
  }
  // Combo-select (Categoria/Editora, 17/07/2026) reaproveita a mesma classe
  // .chip-select-dropdown para o dropdown, mas seu invólucro é .combo-select,
  // não .chip-select — por isso cada regra abaixo é escopada ao próprio
  // invólucro (".chip-select .chip-select-dropdown" / ".combo-select
  // .chip-select-dropdown"); um seletor genérico "todo .chip-select-dropdown
  // da página" fecharia o dropdown de um pelo clique dentro do outro.
  if (!e.target.closest('.chip-select')) {
    document.querySelectorAll('.chip-select .chip-select-dropdown').forEach((d) => (d.style.display = 'none'));
  }
  if (!e.target.closest('.combo-select')) {
    document.querySelectorAll('.combo-select .chip-select-dropdown').forEach((d) => (d.style.display = 'none'));
  }
  if (!e.target.closest('.csel-wrap')) {
    document.querySelectorAll('.csel-wrap.csel-open').forEach((w) => {
      w.querySelector('.csel-panel').style.display = 'none';
      w.classList.remove('csel-open');
      w.querySelector('.csel-trigger')?.setAttribute('aria-expanded', 'false');
    });
  }
});

// Inicializa a aplicação após autenticação confirmada
async function iniciarApp() {
  document.getElementById('loginOverlay').classList.remove('active');
  document.getElementById('appRoot').style.display = '';

  // Pega o usuário atual do Supabase Auth
  try {
    const user = await AuthService.usuarioAtual();
    if (user?.email) {
      usuarioEmail = user.email;
      const nome = user.email.split('@')[0];
      const inicial = nome[0].toUpperCase();
      document.getElementById('userAvatar').textContent = inicial;
      document.getElementById('userDisplayName').textContent = nome;
      document.getElementById('dashboardGreeting').textContent =
        `Bem-vindo de volta, ${nome}! Aqui está o resumo atual da biblioteca.`;
    }
  } catch {}

  try {
    const { error } = await HealthRepo.ping();
    setDbStatus(!error);
  } catch {
    setDbStatus(false);
  }

  // RBAC: descobre o papel e ajusta a UI
  try {
    const res = await PerfilRepo.meu();
    if (res?.data?.papel) papelAtual = res.data.papel;
    // Conta autenticada, mas sem perfil em app_perfil: a API nega tudo (403).
    // Encerra a sessão e volta ao login com o aviso, em vez de abrir a UI vazia.
    if (res?.semPerfil) {
      await AuthService.sair();
      document.getElementById('appRoot').style.display = 'none';
      document.getElementById('loginOverlay').classList.add('active');
      showAlert('loginAlert', res.message, 'error');
      return;
    }
  } catch {}
  document.body.classList.toggle('somente-leitura', papelAtual === 'consulta');

  // Atualiza a exibição do papel no header
  const PAPEL_PT = { admin: 'Administrador', bibliotecario: 'Bibliotecário', consulta: 'Consulta' };
  document.getElementById('userDisplayRole').textContent = PAPEL_PT[papelAtual] || papelAtual;

  // RBAC: só admin vê "Perfis e Permissões" na sidebar (16/07/2026 — saiu do
  // menu do usuário e virou item de navegação; ver #nav-perfis no index.html).
  const navPerfis = document.getElementById('nav-perfis');
  if (navPerfis) navPerfis.style.display = papelAtual === 'admin' ? '' : 'none';

  // RBAC: 'consulta' não vê "Auditoria" na sidebar (expõe e-mails de equipe
  // e histórico detalhado de alterações — ver ACOES_STAFF_APENAS na Edge
  // Function). A API também bloqueia a ação caso o link seja forçado.
  const navAuditoria = document.getElementById('nav-auditoria');
  if (navAuditoria) navAuditoria.style.display = papelAtual === 'consulta' ? 'none' : '';

  // Na sidebar, começa com dashboard ativo
  await loadSelects();
  renderDashboard();
}

function showMeuPerfil(focusSection) {
  document.getElementById('userDropdown')?.classList.remove('open');
  document.querySelector('.user-menu-btn')?.setAttribute('aria-expanded', 'false');
  document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((t) => {
    t.classList.remove('active');
    t.removeAttribute('aria-current');
  });
  document.getElementById('meuPerfil')?.classList.add('active');
  renderMeuPerfil(focusSection || null);
}

async function login() {
  const btn = document.getElementById('btnLogin');
  btn.disabled = true;
  const res = await AuthService.entrar(
    document.getElementById('loginUser').value.trim(),
    document.getElementById('loginPass').value,
  );
  btn.disabled = false;
  if (!res.ok) {
    showAlert('loginAlert', res.message, 'error');
    return;
  }
  document.getElementById('loginPass').value = '';
  await iniciarApp();
}
async function logout() {
  await AuthService.sair();
  location.reload();
}

// Ícones do olho
const ICON_OLHO =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_OLHO_CORTADO =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2"/><path d="M9.9 5.1A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a16.8 16.8 0 0 1-3.1 3.9"/><path d="M6.1 6.1A16.8 16.8 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 3.1-.5"/></svg>';

function toggleLoginSenha() {
  const inp = document.getElementById('loginPass');
  const btn = document.getElementById('btnEye');
  if (!inp) return;
  const mostrar = inp.type === 'password';
  inp.type = mostrar ? 'text' : 'password';
  if (btn) {
    btn.setAttribute('aria-label', mostrar ? 'Ocultar senha' : 'Mostrar senha');
    btn.innerHTML = mostrar ? ICON_OLHO_CORTADO : ICON_OLHO;
  }
}
function esqueceuSenha() {
  showAlert('loginAlert', 'Para redefinir a senha, contate o administrador do sistema.', 'error');
}

window.onload = async function () {
  let sess = null;
  try {
    sess = await AuthService.sessao();
  } catch {}
  if (sess) {
    await iniciarApp();
  } else {
    document.getElementById('loginOverlay').classList.add('active');
    setTimeout(() => document.getElementById('loginUser')?.focus(), 60);
  }
};

// Fecha modais ao clicar fora ou pressionar Escape
document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  if (overlay.id === 'loginOverlay') return;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('active');
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape')
    document.querySelectorAll('.modal-overlay.active').forEach((m) => {
      if (m.id !== 'loginOverlay') m.classList.remove('active');
    });
});
