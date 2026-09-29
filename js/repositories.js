/* ============================================================
   REPOSITORIES — leitura de dados (via API).
   O navegador não conhece mais tabelas/colunas: pede "ações"
   à Edge Function, que é a única que conhece o schema.

   LISTAS: agora paginadas NO SERVIDOR. Cada método `pagina`
   recebe { page, pageSize, q } e devolve { data, error, count }
   (data = só a página pedida; count = total já filtrado).
   ============================================================ */
const UsuarioRepo = {
  pagina: (params) => apiQuery('usuariosPagina', params),
  stats: () => apiQuery('usuariosStats'),
  listarAtivosBasico: () => apiQuery('usuariosAtivosBasico'),
  obter: (id) => apiQuery('usuarioObter', { id }),
  detalhe: (id) => apiQuery('usuarioDetalhe', { id }),
};

const LivroRepo = {
  pagina: (params) => apiQuery('livrosPagina', params),
  listarBasico: () => apiQuery('livrosBasico'),
  obterParaEdicao: (id) => apiQuery('livroParaEdicao', { id }),
  detalhe: (id) => apiQuery('livroDetalhe', { id }),
};

const ExemplarRepo = {
  pagina: (params) => apiQuery('exemplaresPagina', params),
  listarDisponiveis: () => apiQuery('exemplaresDisponiveis'),
  // Tela de Detalhe do Exemplar (16/07/2026, reforma da tela de Exemplares).
  detalhe: (id) => apiQuery('exemplarDetalhe', { id }),
  // Preview do próximo código patrimonial (17/07/2026, feedback sobre a
  // tela de Exemplares) — usado no modal "Novo Exemplar".
  proximoCodigo: () => apiQuery('exemplarProximoCodigo'),
  // Leitores com empréstimo em aberto agora — popula o filtro "Leitor" da
  // tela de Exemplares (17/07/2026, feedback de design).
  leitoresComEmprestimo: () => apiQuery('exemplarLeitoresComEmprestimo'),
};

const EmprestimoRepo = {
  pagina: (params) => apiQuery('emprestimosPagina', params),
  detalhe: (id) => apiQuery('emprestimoDetalhe', { id }),
};

const LivroDisponibilidadeRepo = {
  resumo: (livro_id) => apiQuery('livroResumoDisponibilidade', { livro_id }),
};

const ReservaRepo = {
  pagina: (params) => apiQuery('reservasPagina', params),
  // KPIs do topo da tela de Reservas (17/07/2026, feedback de design):
  // reservas ativas, atendidas e livro mais reservado no momento.
  stats: () => apiQuery('reservasStats'),
};

const MultaRepo = {
  pagina: (params) => apiQuery('multasPagina', params),
};

const CatalogoRepo = {
  categorias: () => apiQuery('catalogoCategorias'),
  editoras: () => apiQuery('catalogoEditoras'),
  autores: () => apiQuery('catalogoAutores'),
};

const DashboardRepo = {
  stats: () => apiQuery('dashboardStats'),
  emprestimosEmAtraso: () => apiQuery('dashboardAtrasos'),
  categorias: () => apiQuery('dashboardCategorias'),
};

// Auditoria — histórico completo de ações (log_auditoria), separado do
// Painel Geral desde 16/07/2026. Reaproveita buscar_pagina() (mesma infra de
// busca fuzzy da Achado 25) via a view vw_log_auditoria_lista.
const AuditoriaRepo = {
  pagina: (params) => apiQuery('auditoriaPagina', params),
  usuarios: () => apiQuery('auditoriaUsuarios'),
};

const HealthRepo = { ping: () => apiQuery('healthPing') };

const PerfilRepo = {
  meu: () => apiQuery('perfilMeu'),
  listar: () => apiQuery('perfisListar'),
  definir: (email, papel) => apiWrite('perfilDefinir', { email, papel }),
  remover: (email) => apiWrite('perfilRemover', { email }),
  reenviarConvite: (email) => apiWrite('perfilReenviarConvite', { email }),
  meusDados: () => apiQuery('meusDados'),
  atualizar: (payload) => apiWrite('perfilAtualizar', payload),
};
