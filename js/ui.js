/* ============================================================
   UI — renderização, manipulação do DOM e handlers de eventos.
   Lê dados via Repositories; grava via Services.
   ============================================================ */
const val = (id) => document.getElementById(id).value.trim();
const raw = (id) => document.getElementById(id).value;
const searchTerm = (id) => (document.getElementById(id)?.value || '').trim();

/* ---------- Formatadores ---------- */
const MESES = ['jan.', 'fev.', 'mar.', 'abr.', 'mai.', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.'];
function fmtData(iso) {
  if (!iso) return '—';
  const parts = String(iso).split('T')[0].split('-');
  if (parts.length < 3) return iso;
  return `${parseInt(parts[2])} ${MESES[parseInt(parts[1]) - 1]} ${parts[0]}`;
}
function fmtMoeda(val) {
  return 'R$ ' + Number(val || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ---------- Instâncias de gráficos (evita criar duplicatas) ---------- */
let _chartDisp = null,
  _chartCat = null;

/* ---------- Navegação ---------- */
function showSection(id, btn) {
  document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((t) => {
    t.classList.remove('active');
    t.removeAttribute('aria-current');
  });
  document.getElementById(id).classList.add('active');
  if (btn) {
    btn.classList.add('active');
    btn.setAttribute('aria-current', 'page');
  }
  // Fecha sidebar no mobile após navegar
  if (window.innerWidth <= 900) {
    document.getElementById('sidebar').classList.add('collapsed');
  }
  pageState[id] = 1;
  const map = {
    dashboard: renderDashboard,
    usuarios: () => {
      loadUsuariosKpis();
      renderUsuarios();
    },
    livros: async () => {
      await loadSelects();
      await renderLivros();
    },
    exemplares: async () => {
      await reloadLivroSelects();
      await renderExemplares();
    },
    emprestimos: async () => {
      resetLeitorFixo('emprestimo');
      const btnNovo = document.getElementById('btnNovoEmprestimo');
      if (btnNovo) btnNovo.style.display = podeEscrever() ? '' : 'none';
      await Promise.all([reloadUsuarioSelects(), reloadExemplarSelects(), reloadLivroSelects()]);
      await renderEmprestimos();
    },
    reservas: async () => {
      resetLeitorFixo('reserva');
      const resumo = document.getElementById('reservaResumoLivro');
      if (resumo) {
        resumo.style.display = 'none';
        resumo.innerHTML = '';
      }
      // Filtro por status (18/07/2026) começa limpo a cada entrada na tela —
      // evita o bibliotecário voltar para Reservas e achar que a tabela está
      // incompleta por causa de um filtro esquecido da visita anterior.
      reservaFiltroStatus = null;
      document.getElementById('rKpiAtivasCard')?.classList.remove('usuarios-kpi-selecionado');
      document.getElementById('rKpiAtendidasCard')?.classList.remove('usuarios-kpi-selecionado');
      loadReservasKpis();
      await Promise.all([reloadUsuarioSelects(), reloadLivroSelects()]);
      await renderReservas();
    },
    multas: renderMultas,
    auditoria: async () => {
      await Promise.all([reloadAuditoriaUsuarioSelect(), popularAuditoriaFiltroAcao()]);
      await renderAuditoria();
    },
    perfis: () => {
      // Mesmo padrão de reservas: filtro por tipo começa limpo a cada
      // entrada na tela (18/07/2026, feedback de design).
      perfilFiltroTipo = null;
      ['pfKpiAdminCard', 'pfKpiBiblioCard', 'pfKpiConsultaCard', 'pfKpiPendentesCard'].forEach((id) =>
        document.getElementById(id)?.classList.remove('usuarios-kpi-selecionado'),
      );
      aoEscolherPapelPerfil();
      renderPerfis();
    },
  };
  // Retorna a promise do carregamento da seção para quem precisar aguardá-la
  // (ex.: novaAcaoParaLeitor, que só pode pré-preencher o leitor depois que
  // os selects forem recarregados). Chamadas existentes que não usam o
  // retorno continuam funcionando normalmente (fire-and-forget).
  return map[id] ? map[id]() : undefined;
}

function changePage(section, page) {
  pageState[section] = page;
  rerender(section);
  document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function filterTable(section) {
  debounce(section, () => {
    pageState[section] = 1;
    rerender(section);
  });
}
function rerender(section) {
  ({
    usuarios: renderUsuarios,
    livros: renderLivros,
    exemplares: renderExemplares,
    emprestimos: renderEmprestimos,
    reservas: renderReservas,
    multas: renderMultas,
    auditoria: renderAuditoria,
  })[section]?.();
}

/* ---------- Selects ---------- */
// Popula um <select> (ou vários, com o mesmo option set) a partir de uma lista de dados.
// Extraído dos três reload*Selects abaixo, que repetiam o mesmo padrão
// (Achado 10 da auditoria 13/07/2026).
function popularSelect(ids, data, mapFn, placeholder = 'Selecione...') {
  const opts = `<option value="">${placeholder}</option>` + (data || []).map(mapFn).join('');
  (Array.isArray(ids) ? ids : [ids]).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = opts;
  });
}
// Caches em memória das listas básicas (leitores ativos / exemplares
// disponíveis / livros). Necessárias porque o modal "Novo Empréstimo" agora
// usa uma cascata Leitor → Livro → Exemplar (item 10 do redesenho de
// 14/07/2026): o select de Exemplar é preenchido dinamicamente, filtrando
// esta lista pelo livro_id escolhido, em vez de fazer uma nova consulta ao
// servidor a cada troca de livro. As mesmas listas também alimentam os
// filtros "Leitor"/"Livro" da tela de Empréstimos.
let _leitoresAtivosData = [];
let _exemplaresDisponiveisData = [];
let _livrosBasicoData = [];

async function reloadUsuarioSelects() {
  const { data, error } = await UsuarioRepo.listarAtivosBasico();
  if (error) {
    console.warn('reloadUsuarioSelects:', error.message);
    return;
  }
  _leitoresAtivosData = data || [];
  popularSelect(
    ['emprestimoUsuario', 'reservaUsuario'],
    _leitoresAtivosData,
    (u) => `<option value="${u.usuario_id}">${sanitize(u.nome)}</option>`,
  );
  const filtroLeitor = document.getElementById('emprestimoFiltroLeitor');
  if (filtroLeitor) {
    const atual = filtroLeitor.value;
    popularSelect(
      'emprestimoFiltroLeitor',
      _leitoresAtivosData,
      (u) => `<option value="${u.usuario_id}">${sanitize(u.nome)}</option>`,
      'Todos os leitores',
    );
    filtroLeitor.value = atual;
  }
}
async function reloadExemplarSelects() {
  const { data, error } = await ExemplarRepo.listarDisponiveis();
  if (error) {
    console.warn('reloadExemplarSelects:', error.message);
    return;
  }
  _exemplaresDisponiveisData = data || [];
  // Se o modal de Novo Empréstimo estiver aberto com um livro já escolhido,
  // atualiza a lista filtrada de exemplares para refletir o dado mais recente.
  const livroSel = document.getElementById('emprestimoLivro');
  if (livroSel && livroSel.value) popularExemplarPorLivro(livroSel.value);

  // Filtro "Leitor" da tela de Exemplares (17/07/2026, feedback de design) —
  // só lista quem tem empréstimo em aberto agora (lista pequena e útil como
  // filtro, ao contrário de todos os leitores ativos da biblioteca).
  const filtroLeitorEx = document.getElementById('exemplarFiltroLeitor');
  if (filtroLeitorEx) {
    const { data: leitores, error: errLeitores } = await ExemplarRepo.leitoresComEmprestimo();
    if (!errLeitores) {
      const atual = filtroLeitorEx.value;
      popularSelect(
        'exemplarFiltroLeitor',
        leitores || [],
        (u) => `<option value="${u.usuario_id}">${sanitize(u.nome)}</option>`,
        'Todos os leitores',
      );
      filtroLeitorEx.value = atual;
    }
  }
}
async function reloadLivroSelects() {
  const { data, error } = await LivroRepo.listarBasico();
  if (error) {
    console.warn('reloadLivroSelects:', error.message);
    return;
  }
  _livrosBasicoData = data || [];
  popularSelect(
    ['exemplarLivro', 'reservaLivro', 'emprestimoLivro'],
    _livrosBasicoData,
    (l) => `<option value="${l.livro_id}">${sanitize(l.titulo)}</option>`,
  );
  const filtroLivro = document.getElementById('emprestimoFiltroLivro');
  if (filtroLivro) {
    const atual = filtroLivro.value;
    popularSelect(
      'emprestimoFiltroLivro',
      _livrosBasicoData,
      (l) => `<option value="${l.livro_id}">${sanitize(l.titulo)}</option>`,
      'Todos os livros',
    );
    filtroLivro.value = atual;
  }
  // Filtro de Livro na tela de Exemplares (16/07/2026, reforma da tela).
  const filtroLivroEx = document.getElementById('exemplarFiltroLivro');
  if (filtroLivroEx) {
    const atualEx = filtroLivroEx.value;
    popularSelect(
      'exemplarFiltroLivro',
      _livrosBasicoData,
      (l) => `<option value="${l.livro_id}">${sanitize(l.titulo)}</option>`,
      'Todos os livros',
    );
    filtroLivroEx.value = atualEx;
  }
}
// Preenche o select de Exemplar do modal "Novo Empréstimo" filtrando a lista
// de disponíveis (cache local) pelo livro escolhido — sem round-trip ao
// servidor a cada troca de livro.
function popularExemplarPorLivro(livroId) {
  const sel = document.getElementById('emprestimoExemplar');
  if (!sel) return;
  const filtrados = _exemplaresDisponiveisData.filter((e) => String(e.livro_id) === String(livroId));
  if (!filtrados.length) {
    sel.innerHTML = '<option value="">Nenhum exemplar disponível para este livro</option>';
    sel.disabled = true;
    return;
  }
  sel.innerHTML =
    '<option value="">Selecione...</option>' +
    filtrados.map((e) => `<option value="${e.exemplar_id}">${sanitize(e.codigo_patrimonial)}</option>`).join('');
  sel.disabled = false;
}
async function loadSelects() {
  // ExemplarRepo.listarDisponiveis() não é mais buscado aqui: desde o
  // redesenho da tela de Empréstimos (14/07/2026), quem mantém esse cache é
  // reloadExemplarSelects() (chamado ao entrar em Empréstimos), consumido
  // por popularExemplarPorLivro() na cascata do modal "Novo Empréstimo".
  const [cats, eds, auts, livs, usus] = await Promise.all([
    CatalogoRepo.categorias(),
    CatalogoRepo.editoras(),
    CatalogoRepo.autores(),
    LivroRepo.listarBasico(),
    UsuarioRepo.listarAtivosBasico(),
  ]);
  // Cache global de autores/categorias/editoras para os seletores pesquisáveis
  // com criação rápida (chip-select de autor, combo-select de
  // categoria/editora — 17/07/2026).
  _autoresData = auts.data || [];
  _categoriasData = cats.data || [];
  _editorasData = eds.data || [];

  const catOpts =
    '<option value="">Selecione...</option>' +
    _categoriasData.map((c) => `<option value="${c.categoria_id}">${sanitize(c.nome_categoria)}</option>`).join('');
  const edOpts =
    '<option value="">Selecione...</option>' +
    _editorasData.map((e) => `<option value="${e.editora_id}">${sanitize(e.nome_editora)}</option>`).join('');
  const autOpts = _autoresData.map((a) => `<option value="${a.autor_id}">${sanitize(a.nome_autor)}</option>`).join('');

  // Modais de livro (criar / editar)
  document.getElementById('livroCategoria').innerHTML = catOpts;
  document.getElementById('livroEditora').innerHTML = edOpts;
  document.getElementById('livroAutores').innerHTML = autOpts;
  document.getElementById('editLivroCategoria').innerHTML = catOpts;
  document.getElementById('editLivroEditora').innerHTML = edOpts;
  document.getElementById('editLivroAutores').innerHTML = autOpts;

  // Filtros da tela de livros (selects ocultos + sync nos custom selects)
  const filtCatEl = document.getElementById('livroFiltroCategoria');
  if (filtCatEl) {
    filtCatEl.innerHTML =
      '<option value="">Categoria</option>' +
      _categoriasData.map((c) => `<option value="${c.categoria_id}">${sanitize(c.nome_categoria)}</option>`).join('');
    cselSyncFromHidden('cselLivroCategoria');
  }
  const filtEdEl = document.getElementById('livroFiltroEditora');
  if (filtEdEl) {
    filtEdEl.innerHTML =
      '<option value="">Editora</option>' +
      _editorasData.map((e) => `<option value="${e.editora_id}">${sanitize(e.nome_editora)}</option>`).join('');
    cselSyncFromHidden('cselLivroEditora');
  }

  // Outros selects do sistema
  document.getElementById('exemplarLivro').innerHTML =
    '<option value="">Selecione...</option>' +
    (livs.data || []).map((l) => `<option value="${l.livro_id}">${sanitize(l.titulo)}</option>`).join('');
  const usuOpts =
    '<option value="">Selecione...</option>' +
    (usus.data || []).map((u) => `<option value="${u.usuario_id}">${sanitize(u.nome)}</option>`).join('');
  document.getElementById('emprestimoUsuario').innerHTML = usuOpts;
  document.getElementById('reservaUsuario').innerHTML = usuOpts;
  // #emprestimoExemplar não é mais populado aqui: desde o redesenho da tela
  // de Empréstimos (14/07/2026) ele é preenchido dinamicamente por
  // popularExemplarPorLivro(), filtrado pelo livro escolhido na cascata do
  // modal "Novo Empréstimo" — ver reloadExemplarSelects()/abrirModalNovoEmprestimo().
  document.getElementById('reservaLivro').innerHTML =
    '<option value="">Selecione...</option>' +
    (livs.data || []).map((l) => `<option value="${l.livro_id}">${sanitize(l.titulo)}</option>`).join('');
}

// Rótulos em português para o campo `acao` do log de auditoria (log_auditoria).
// Usado tanto no Painel Geral (indiretamente, via Auditoria) quanto na própria
// página de Auditoria — ver renderAuditoriaTimeline().
const ACAO_PT = {
  'usuario.criar': 'Leitor cadastrado',
  'usuario.atualizar': 'Leitor atualizado',
  'usuario.inativar': 'Leitor inativado',
  'usuario.reativar': 'Leitor reativado',
  'livro.criar': 'Livro cadastrado',
  'livro.atualizar': 'Livro atualizado',
  'livro.excluir': 'Livro excluído',
  'exemplar.criar': 'Exemplar cadastrado',
  'exemplar.status': 'Status de exemplar atualizado',
  // 'exemplar.excluir' faltava neste mapa desde que a ação foi criada
  // (reforma da tela de Exemplares, 16/07/2026) — corrigido ao mexer neste
  // mapa para a criação rápida de dados auxiliares (17/07/2026).
  'exemplar.excluir': 'Exemplar excluído',
  'emprestimo.criar': 'Empréstimo registrado',
  'emprestimo.devolver': 'Livro devolvido',
  'reserva.criar': 'Reserva criada',
  'reserva.status': 'Reserva atualizada',
  'multa.pagar': 'Multa paga',
  'perfil.definir': 'Papel de acesso definido',
  'perfil.atualizar': 'Perfil próprio atualizado',
  // Criação rápida de dados auxiliares (17/07/2026) — categoria/editora/autor
  // criados a partir do modal de cadastro de Livro.
  'categoria.criar': 'Categoria cadastrada',
  'editora.criar': 'Editora cadastrada',
  'autor.criar': 'Autor cadastrado',
};
// Rótulos em português para o campo `entidade` do log de auditoria — usado
// tanto na tabela da página Auditoria quanto no filtro "Entidade".
const ENTIDADE_PT = {
  usuario: 'Leitor',
  livro: 'Livro',
  exemplar: 'Exemplar',
  emprestimo: 'Empréstimo',
  reserva: 'Reserva',
  multa: 'Multa',
  app_perfil: 'Perfil de acesso',
  categoria: 'Categoria',
  editora: 'Editora',
  autor: 'Autor',
};

/* ---------- Dashboard ---------- */
async function renderDashboard() {
  // Busca em paralelo: stats + atrasos + categorias
  // (Atividade Recente saiu do Painel Geral em 16/07/2026 — ver página
  // Auditoria, que mostra o histórico completo de ações com filtros.)
  const [stRes, atRes, catRes] = await Promise.all([
    DashboardRepo.stats(),
    DashboardRepo.emprestimosEmAtraso(),
    DashboardRepo.categorias(),
  ]);

  /* --- KPIs --- */
  const statsEl = document.getElementById('statsContainer');
  if (stRes.error) {
    statsEl.innerHTML = `<div class="alert alert-error" style="grid-column:1/-1">Erro ao carregar estatísticas: ${sanitize(stRes.error.message)}</div>`;
  } else {
    const s = stRes.data || {};
    const totalEx = Number(s.exemplares || 0);
    const dispEx = Number(s.exemplares_disponiveis || 0);
    const pctDisp = totalEx > 0 ? Math.round((dispEx / totalEx) * 100) : 0;
    statsEl.innerHTML = `
        <div class="stat-card">
            <div class="kpi-value">${s.usuarios ?? 0}</div>
            <div class="kpi-label">Leitores Ativos</div>
        </div>
        <div class="stat-card green">
            <div class="kpi-value">${s.livros ?? 0}</div>
            <div class="kpi-label">Títulos no Acervo</div>
        </div>
        <div class="stat-card gold">
            <div class="kpi-value">${dispEx}</div>
            <div class="kpi-label">Exemplares Disponíveis</div>
            <div class="kpi-sub">${pctDisp}% do total de ${totalEx}</div>
        </div>
        <div class="stat-card teal">
            <div class="kpi-value">${s.emprestimosAtivos ?? 0}</div>
            <div class="kpi-label">Empréstimos Ativos</div>
        </div>
        <div class="stat-card slate">
            <div class="kpi-value">${s.reservasPendentes ?? 0}</div>
            <div class="kpi-label">Reservas Pendentes</div>
        </div>
        <div class="stat-card amber">
            <div class="kpi-value">${s.multasEmAberto ?? 0}</div>
            <div class="kpi-label">Multas em Aberto</div>
        </div>`;

    /* --- Gráficos --- */
    renderGraficos(s, catRes.data || []);
  }

  /* --- Tabela de atrasos --- */
  const tbody = document.getElementById('atrasosTable');
  const banner = document.getElementById('overduesBanner');
  if (atRes.error) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Erro: ${sanitize(atRes.error.message)}</td></tr>`;
    if (banner) banner.style.display = 'none';
    return;
  }
  const atrasados = atRes.data || [];
  if (banner) {
    banner.style.display = atrasados.length ? 'flex' : 'none';
    document.getElementById('overduesCount').textContent = atrasados.length;
  }
  if (!atrasados.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Nenhum empréstimo em atraso.</td></tr>';
  } else {
    tbody.innerHTML = atrasados
      .map((e) => {
        const dias = Number(e.dias_atraso || 0);
        const muitoAtrasado = dias > 30;
        const situacaoBadge = muitoAtrasado
          ? `<span class="status-muito-atrasado"><span class="status-dot red"></span>Muito atrasado</span>`
          : `<span class="status-atrasado"><span class="status-dot orange"></span>Atrasado</span>`;
        const acaoBtn = podeEscrever()
          ? `<button class="btn btn-success btn-sm" onclick="showSection('emprestimos',document.getElementById('nav-emprestimos'))" aria-label="Ir para empréstimos">Devolver</button>`
          : '&#8212;';
        return `<tr>
                <td data-label="Livro"><strong>${sanitize(e.titulo)}</strong></td>
                <td data-label="Leitor">${sanitize(e.nome)}</td>
                <td data-label="Situação">${situacaoBadge}</td>
                <td data-label="Dias"><span class="badge badge-${muitoAtrasado ? 'overdue' : 'warning'}">${dias} dias</span></td>
                <td data-label="Multa">${fmtMoeda(e.valor_multa)}</td>
                <td class="td-actions">${acaoBtn}</td>
            </tr>`;
      })
      .join('');
  }
}

function renderGraficos(s, categorias) {
  const chartsRow = document.getElementById('chartsRow');
  if (!chartsRow) return;
  chartsRow.style.display = 'grid';

  const dispEx = Number(s.exemplares_disponiveis || 0);
  const totalEx = Number(s.exemplares || 0);
  const empEx = totalEx - dispEx;
  const outros = Math.max(0, totalEx - dispEx - empEx);

  /* Gráfico 1: Donut de disponibilidade */
  const ctxDisp = document.getElementById('chartDisponibilidade');
  if (ctxDisp) {
    if (_chartDisp) _chartDisp.destroy();
    _chartDisp = new Chart(ctxDisp, {
      type: 'doughnut',
      data: {
        labels: ['Disponíveis', 'Emprestados', 'Outros'],
        datasets: [
          {
            data: [dispEx, empEx, outros],
            backgroundColor: ['#034601', '#810102', '#D4BF82'],
            borderWidth: 0,
            hoverOffset: 4,
          },
        ],
      },
      options: {
        cutout: '72%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#3b0001',
            titleColor: '#D4BF82',
            bodyColor: '#F0E7C4',
            callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.parsed}` },
          },
        },
      },
    });
    const leg = document.getElementById('legendDisponibilidade');
    if (leg)
      leg.innerHTML = [
        { cor: '#034601', label: 'Disponíveis', n: dispEx },
        { cor: '#810102', label: 'Emprestados', n: empEx },
        { cor: '#D4BF82', label: 'Outros', n: outros },
      ]
        .filter((i) => i.n > 0)
        .map(
          (i) =>
            `<div class="chart-legend-item"><span class="chart-legend-dot" style="background:${i.cor}"></span><span>${i.label} (${i.n})</span></div>`,
        )
        .join('');
  }

  /* Gráfico 2: Barras horizontais por categoria */
  const ctxCat = document.getElementById('chartCategorias');
  if (ctxCat && categorias.length) {
    if (_chartCat) _chartCat.destroy();
    const cats = categorias.slice(0, 8);
    _chartCat = new Chart(ctxCat, {
      type: 'bar',
      data: {
        labels: cats.map((c) => c.nome || 'Sem cat.'),
        datasets: [
          {
            data: cats.map((c) => c.total || 0),
            backgroundColor: 'rgba(129,1,2,.75)',
            borderRadius: 6,
            borderSkipped: false,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#3b0001',
            titleColor: '#D4BF82',
            bodyColor: '#F0E7C4',
            callbacks: { label: (ctx) => ` ${ctx.parsed.x} livro(s)` },
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(212,191,130,.2)' },
            ticks: { font: { size: 11 }, color: '#5a3a30' },
          },
          y: {
            grid: { display: false },
            ticks: { font: { size: 11 }, color: '#5a3a30' },
          },
        },
        maintainAspectRatio: false,
      },
    });
  }
}

/* ---------- Skeleton comum das telas paginadas (tabela + busca + paginação) ---------- */
// Extraído das seis funções render* (leitores, livros, exemplares, empréstimos,
// reservas, multas), que repetiam o mesmo esqueleto: loading -> fetch -> erro ->
// hint -> vazio -> linhas -> paginação (Achado 10 da auditoria 13/07/2026).
async function renderPaginado({
  tbodyId,
  paginationId,
  colspan,
  section,
  fetch,
  rowFn,
  loadingMsg = 'Carregando...',
  onCount, // opcional: (count) => void — atualiza um hint de resultados
  filterRows, // opcional: (rows) => rows — filtro client-side após o fetch (ex.: livros)
  emptyMsg, // string simples -> <td class="empty-state">emptyMsg</td>
  emptyTd, // ou, para estados vazios com HTML customizado: () => tdInnerHtml (sem a classe empty-state)
  extraRowsHtml, // opcional: (rows) => string extra após as linhas mapeadas (ex.: nota das multas)
}) {
  const tbody = document.getElementById(tbodyId);
  const paginationEl = document.getElementById(paginationId);
  tbody.innerHTML = `<tr><td colspan="${colspan}" class="loading">${loadingMsg}</td></tr>`;
  const { data, count, error } = await fetch();
  if (error) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="empty-state">Erro: ${sanitize(error.message)}</td></tr>`;
    paginationEl.innerHTML = '';
    return;
  }
  if (onCount) onCount(count);
  let rows = data || [];
  if (filterRows) rows = filterRows(rows);
  if (!rows.length) {
    tbody.innerHTML = emptyTd
      ? `<tr><td colspan="${colspan}">${emptyTd()}</td></tr>`
      : `<tr><td colspan="${colspan}" class="empty-state">${emptyMsg}</td></tr>`;
    paginationEl.innerHTML = '';
    return;
  }
  tbody.innerHTML = rows.map(rowFn).join('') + (extraRowsHtml ? extraRowsHtml(rows) : '');
  paginationEl.innerHTML = paginationHTML(count, pageState[section], section);
}

/* ---------- Leitores ---------- */
function fmtTelefone(v) {
  if (!v) return '—';
  const t = String(v).replace(/\D/g, '');
  if (t.length === 11) return `(${t.slice(0, 2)}) ${t.slice(2, 7)}-${t.slice(7)}`;
  if (t.length === 10) return `(${t.slice(0, 2)}) ${t.slice(2, 6)}-${t.slice(6)}`;
  return v;
}
function mascaraCPF(el) {
  let v = el.value.replace(/\D/g, '').slice(0, 11);
  if (v.length > 9) v = v.replace(/^(\d{3})(\d{3})(\d{3})(\d{0,2})$/, '$1.$2.$3-$4');
  else if (v.length > 6) v = v.replace(/^(\d{3})(\d{3})(\d+)$/, '$1.$2.$3');
  else if (v.length > 3) v = v.replace(/^(\d{3})(\d+)$/, '$1.$2');
  el.value = v;
}
function mascaraTelefone(el) {
  let v = el.value.replace(/\D/g, '').slice(0, 11);
  if (v.length > 10) v = v.replace(/^(\d{2})(\d{5})(\d{0,4})$/, '($1) $2-$3');
  else if (v.length > 6) v = v.replace(/^(\d{2})(\d{4,5})(\d+)$/, '($1) $2-$3');
  else if (v.length > 2) v = v.replace(/^(\d{2})(\d+)$/, '($1) $2');
  el.value = v;
}
function toggleActionMenu(btn) {
  const wrap = btn.closest('.action-menu-wrap');
  const menu = wrap.querySelector('.action-menu');
  const wasOpen = menu.classList.contains('open');
  document.querySelectorAll('.action-menu.open').forEach((m) => m.classList.remove('open'));
  if (!wasOpen) menu.classList.add('open');
}
async function loadUsuariosKpis() {
  const { data } = await UsuarioRepo.stats();
  if (!data) return;
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v ?? '—';
  };
  set('uKpiTotal', data.total);
  set('uKpiAtivos', data.ativos);
  set('uKpiComEmprestimos', data.comEmprestimosAtivos);
  set('uKpiComMultas', data.comMultasPendentes);
}
// KPIs do topo da tela de Reservas (17/07/2026, feedback de design) — mesmo
// padrão de loadUsuariosKpis. 18/07/2026: "Livro mais reservado" passou a
// mostrar título e contagem em duas linhas (mais legível que "1984 (3)"), e
// os cartões "Reservas ativas"/"Atendidas" viraram filtros clicáveis da
// tabela abaixo (ver filtrarReservasPorStatus/reservaFiltroStatus).
async function loadReservasKpis() {
  const { data } = await ReservaRepo.stats();
  if (!data) return;
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v ?? '—';
  };
  set('rKpiAtivas', data.ativas);
  set('rKpiAtendidas', data.atendidas);
  const top = data.livroMaisReservado;
  set('rKpiMaisReservadoTitulo', top ? top.titulo : '—');
  set('rKpiMaisReservadoContagem', top ? `${top.total} reserva${top.total === 1 ? '' : 's'}` : '');
}
// Filtro por status via clique nos KPIs (18/07/2026, feedback de design) —
// clicar de novo no mesmo cartão limpa o filtro (alterna, não só liga).
let reservaFiltroStatus = null;
function filtrarReservasPorStatus(status) {
  reservaFiltroStatus = reservaFiltroStatus === status ? null : status;
  const marcar = (id, ativo) => document.getElementById(id)?.classList.toggle('usuarios-kpi-selecionado', ativo);
  marcar('rKpiAtivasCard', reservaFiltroStatus === 'Ativa');
  marcar('rKpiAtendidasCard', reservaFiltroStatus === 'Atendida');
  pageState.reservas = 1;
  renderReservas();
}
async function renderUsuarios() {
  const term = searchTerm('usuariosSearch');
  const status = document.getElementById('filtroStatusUsuarios')?.value || '';
  const sort = document.getElementById('filtroOrdemUsuarios')?.value || 'nome';
  await renderPaginado({
    tbodyId: 'usuariosTable',
    paginationId: 'usuariosPagination',
    colspan: 5,
    section: 'usuarios',
    fetch: () => UsuarioRepo.pagina({ page: pageState.usuarios, pageSize: PAGE_SIZE, q: term, status, sort }),
    onCount: (count) => {
      const hintEl = document.getElementById('usuariosHint');
      const n = Number(count) || 0;
      if (hintEl) hintEl.textContent = term ? `${n} resultado(s) para "${term}"` : `${n} leitor(es) encontrado(s)`;
    },
    emptyMsg: `
            <strong>Nenhum leitor encontrado.</strong><br>
            <span style="font-size:13px">Tente ajustar os filtros ou cadastre um novo leitor.</span>
        `,
    rowFn: (u) => {
      const id = u.usuario_id;
      const contato = `<div class="contact-cell">
            <span>${sanitize(u.email)}</span>
            <span>${fmtTelefone(u.telefone)}</span>
        </div>`;
      const acoes = podeEscrever()
        ? `<div class="action-menu-wrap">
                 <button class="btn-icon" onclick="event.stopPropagation();toggleActionMenu(this)" title="Mais ações" aria-haspopup="true">
                   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                 </button>
                 <div class="action-menu" role="menu">
                   ${
                     u.ativo
                       ? `<button role="menuitem" class="action-menu-item--danger" onclick="event.stopPropagation();desativarUsuario('${id}')">Desativar</button>`
                       : `<button role="menuitem" class="action-menu-item--success" onclick="event.stopPropagation();ativarUsuario('${id}')">Reativar</button>`
                   }
                 </div>
               </div>`
        : '&#8212;';
      return `<tr class="clickable-row" data-id="${id}" onclick="abrirDetalhesLeitor(this.dataset.id)">
            <td data-label="Nome"><strong>${destacarTrecho(u.nome, term)}</strong></td>
            <td data-label="Contato">${contato}</td>
            <td data-label="CPF">${fmtCPF(u.cpf)}</td>
            <td data-label="Status">${u.ativo ? '<span class="badge badge-success">Ativo</span>' : '<span class="badge badge-danger">Inativo</span>'}</td>
            <td class="td-actions" data-label="Ações" onclick="event.stopPropagation()">${acoes}</td>
        </tr>`;
    },
  });
}
function abrirModalNovoUsuario() {
  ['novoNome', 'novoCPF', 'novoEmail', 'novoTelefone'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const a = document.getElementById('novoUsuarioAlert');
  if (a) a.innerHTML = '';
  abrirModal('modalNovoUsuario');
}
async function createUsuario() {
  const cpfRaw = (document.getElementById('novoCPF')?.value || '').replace(/\D/g, '');
  if (!validarCPF(cpfRaw)) {
    showAlert('novoUsuarioAlert', 'CPF inválido. Verifique os dígitos digitados.', 'error');
    return;
  }
  const btn = document.getElementById('btnCriarUsuario');
  btn.disabled = true;
  const telRaw = (document.getElementById('novoTelefone')?.value || '').replace(/\D/g, '') || null;
  const res = await UsuarioService.criar({
    nome: val('novoNome'),
    email: val('novoEmail'),
    cpf: cpfRaw,
    telefone: telRaw,
  });
  btn.disabled = false;
  showAlert('novoUsuarioAlert', res.message, res.ok ? 'success' : 'error');
  if (!res.ok) return;
  fecharModal('modalNovoUsuario');
  pageState.usuarios = 1;
  await reloadUsuarioSelects();
  loadUsuariosKpis();
  await renderUsuarios();
}
async function openEditUsuario(id) {
  const { data: u, error } = await UsuarioRepo.obter(id);
  if (error || !u) {
    showAlert('usuarioAlert', 'Erro ao carregar leitor.', 'error');
    return;
  }
  document.getElementById('editUsuarioId').value = u.usuario_id;
  document.getElementById('editUsuarioNome').value = u.nome;
  document.getElementById('editUsuarioEmail').value = u.email;
  document.getElementById('editUsuarioTelefone').value = u.telefone || '';
  abrirModal('modalUsuario');
}
/* ===== CENTRAL DO LEITOR — painel de detalhes com linha do tempo ===== */
let _leitorDetalheId = null;

const MESES_LONGOS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];
function fmtMesAno(iso) {
  const partes = String(iso).split('T')[0].split('-');
  if (partes.length < 2) return null;
  return `${MESES_LONGOS[parseInt(partes[1]) - 1]} de ${partes[0]}`;
}
function fmtHora(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function tituloGrupoData(diaStr) {
  const hoje = todayStr();
  const ontemDate = new Date();
  ontemDate.setDate(ontemDate.getDate() - 1);
  const ontem = ontemDate.toISOString().split('T')[0];
  if (diaStr === hoje) return 'Hoje';
  if (diaStr === ontem) return 'Ontem';
  return fmtData(diaStr);
}

/* Ícones da timeline (mesmo estilo linear usado no resto do app) */
const ICONE_LIVRO =
  '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>';
const ICONE_CHECK = '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>';
const ICONE_MARCADOR = '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>';
const ICONE_MOEDA = '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>';
const ICONE_PESSOA = '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>';
const ICONE_BLOQUEIO = '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>';
// Ícone dos marcos sintéticos do painel de detalhes do Empréstimo (não vêm de
// log_auditoria — são cálculos de prazo, ver emprestimoDetalhe no backend).
const ICONE_RELOGIO = '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>';
// Ícone de "novo exemplar cadastrado" no histórico do Livro (redesenho de 14/07/2026).
const ICONE_MAIS =
  '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>';
// Ícone de "status alterado" no histórico do Exemplar (16/07/2026, reforma
// da tela de Exemplares) — setas de troca.
const ICONE_TROCA =
  '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>';
const TIMELINE_ICONE = {
  emprestimo: ICONE_LIVRO,
  devolucao: ICONE_CHECK,
  multa: ICONE_MOEDA,
  multa_paga: ICONE_MOEDA,
  reserva: ICONE_MARCADOR,
  reserva_atendida: ICONE_CHECK,
  reserva_cancelada: ICONE_BLOQUEIO,
  cadastro: ICONE_PESSOA,
  prazo_expirado: ICONE_RELOGIO,
  pendente: ICONE_RELOGIO,
  livro_cadastro: ICONE_LIVRO,
  exemplar_cadastro: ICONE_MAIS,
  exemplar_cadastro_lote: ICONE_MAIS,
  status_alterado: ICONE_TROCA,
};
function svgTimeline(tipo) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TIMELINE_ICONE[tipo] || ICONE_LIVRO}</svg>`;
}

function tituloEvento(ev) {
  // Evento sintético de "lote" (ver agruparExemplaresCadastro) — o título
  // depende da quantidade, por isso fica fora do mapa estático.
  if (ev.tipo === 'exemplar_cadastro_lote') return `${ev.exemplares.length} exemplares cadastrados`;
  // status_alterado (16/07/2026, histórico do Exemplar): título depende do
  // sentido da mudança, por isso fica fora do mapa estático.
  if (ev.tipo === 'status_alterado') {
    if (ev.para === 'Baixado') return 'Exemplar baixado';
    if (ev.de === 'Baixado') return 'Exemplar reativado';
    return 'Status alterado';
  }
  return (
    {
      emprestimo: 'Empréstimo realizado',
      devolucao: 'Livro devolvido',
      multa: 'Multa gerada',
      multa_paga: 'Multa paga',
      reserva: 'Reserva criada',
      reserva_atendida: 'Reserva atendida',
      reserva_cancelada: 'Reserva cancelada',
      cadastro: ev.titulo || 'Cadastro atualizado',
      livro_cadastro: 'Livro cadastrado',
      exemplar_cadastro: 'Novo exemplar cadastrado',
    }[ev.tipo] || ev.tipo
  );
}
// ev.usuario_nome só vem preenchido no histórico do Livro (livroDetalhe) —
// no histórico do Leitor (usuarioDetalhe) esses eventos já são sobre o
// próprio leitor, então o resumo continua mostrando o livro normalmente.
// Revisado em 16/07/2026: o resumo (linha colapsada) passou a incluir o
// destaque mais relevante de cada tipo de evento — não só o nome — para que
// dê pra entender o essencial sem precisar expandir ("Bruno Lima · EX0007 ·
// 5 dias de atraso · Multa R$ 12,00" em vez de só "Bruno Lima").
function resumoEvento(ev) {
  const nome = sanitize(ev.usuario_nome || ev.livro || 'Livro');
  switch (ev.tipo) {
    case 'emprestimo':
      return [nome, ev.exemplar ? sanitize(ev.exemplar) : null].filter(Boolean).join(' · ');
    case 'devolucao': {
      const partes = [nome];
      if (ev.exemplar) partes.push(sanitize(ev.exemplar));
      if (ev.dias_atraso > 0) partes.push(`${ev.dias_atraso} dia${ev.dias_atraso === 1 ? '' : 's'} de atraso`);
      if (ev.multa_valor != null) partes.push(`Multa ${fmtMoeda(ev.multa_valor)}`);
      return partes.join(' · ');
    }
    case 'reserva':
      return [nome, ev.fila != null ? `${ev.fila}ª posição da fila` : null].filter(Boolean).join(' · ');
    case 'reserva_atendida':
    case 'reserva_cancelada':
      return nome;
    case 'multa':
    case 'multa_paga':
      return `${sanitize(ev.livro || 'Livro')} · ${fmtMoeda(ev.valor)}`;
    case 'cadastro':
      return (ev.alteracoes || []).map((a) => sanitize(a.campo)).join(', ');
    case 'livro_cadastro':
      return ev.isbn ? `ISBN ${sanitize(ev.isbn)}` : '';
    case 'exemplar_cadastro':
      return sanitize(ev.exemplar || '');
    case 'exemplar_cadastro_lote':
      return (ev.exemplares || []).map(sanitize).join(', ');
    case 'status_alterado': {
      // 19/07/2026, feedback de design: registros antigos de auditoria não
      // têm o "de" (formato legado, ver exemplarDetalhe no backend) — nesse
      // caso não força mais "— → X", só mostra o "para" sozinho.
      const para = EXEMPLAR_STATUS_PT[ev.para] || ev.para || '—';
      const de = ev.de ? EXEMPLAR_STATUS_PT[ev.de] || ev.de : null;
      const partes = [de ? `${de} → ${para}` : para];
      if (ev.motivo) partes.push(sanitize(ev.motivo));
      return partes.join(' · ');
    }
    default:
      return '';
  }
}
// Monta as linhas do painel expandido de cada evento (campos pedidos por tipo).
// `contexto` ('leitor' | 'livro' | null) permite esconder o campo redundante
// com a própria tela onde a timeline está sendo exibida — pedido de design de
// 16/07/2026 ("o histórico é muito verboso... a tela já mostra Leitor/Livro").
function detalhesEvento(ev, contexto = null) {
  const L = (label, valor) => (valor === null || valor === undefined || valor === '' ? null : { label, valor });
  // "Meta" (19/07/2026, quinta rodada de feedback — "eu definiria um
  // padrão... Responsável / Data / Hora"): Responsável e Horário são o
  // rodapé comum de todo evento, não um dado específico do tipo — marcados
  // à parte (meta:true) para ganhar um divisor visual antes deles em vez de
  // se misturar na mesma lista dos campos específicos (ver renderLeitorTimeline).
  const M = (label, valor) =>
    valor === null || valor === undefined || valor === '' ? null : { label, valor, meta: true };
  // Responsável só aparece quando o dado existe de fato — antes mostrava "—"
  // mesmo vazio; pedido explícito: "se não existe, não mostrar". Mostra só a
  // parte local do e-mail (16/07/2026: "o e-mail não é amigável" — em vez
  // de "adminlume@lume.local", mostra só "adminlume").
  const respLinha = M('Responsável', ev.responsavel ? String(ev.responsavel).split('@')[0] : null);
  // 'Livro' é redundante dentro do próprio painel de Detalhes do Livro.
  const linhaLivro = contexto === 'livro' ? null : L('Livro', ev.livro);
  let linhas = [];
  switch (ev.tipo) {
    case 'emprestimo':
      linhas = [
        ev.usuario_nome ? L('Leitor', ev.usuario_nome) : null,
        linhaLivro,
        L('Exemplar', ev.exemplar),
        L('Retirada', fmtData(ev.data_retirada)),
        L('Prazo', fmtData(ev.data_prevista)),
        L('Devolução', ev.data_devolucao ? fmtData(ev.data_devolucao) : 'Ainda não devolvido'),
        L('Situação', ev.situacao),
        ev.dias_atraso > 0 ? L('Atraso', `${ev.dias_atraso} dia${ev.dias_atraso === 1 ? '' : 's'}`) : null,
        ev.multa_valor != null ? L('Multa gerada', fmtMoeda(ev.multa_valor)) : null,
        respLinha,
      ];
      break;
    case 'devolucao':
      linhas = [
        ev.usuario_nome ? L('Leitor', ev.usuario_nome) : null,
        linhaLivro,
        L('Exemplar', ev.exemplar),
        L('Data da devolução', fmtData(ev.data_devolucao)),
        L('Atraso', ev.dias_atraso > 0 ? `${ev.dias_atraso} dia${ev.dias_atraso === 1 ? '' : 's'}` : 'Sem atraso'),
        L('Valor da multa', ev.multa_valor != null ? fmtMoeda(ev.multa_valor) : 'Sem multa'),
        respLinha,
      ];
      break;
    case 'multa':
      linhas = [
        linhaLivro,
        L('Motivo', ev.motivo),
        L('Valor', fmtMoeda(ev.valor)),
        L('Data de geração', fmtData(String(ev.data_geracao || '').split('T')[0])),
        L('Data de pagamento', ev.data_pagamento ? fmtData(ev.data_pagamento) : 'Ainda não paga'),
        L('Status', ev.status),
        respLinha,
      ];
      break;
    case 'multa_paga':
      linhas = [
        linhaLivro,
        L('Valor', fmtMoeda(ev.valor)),
        L('Data de pagamento', ev.data_pagamento ? fmtData(ev.data_pagamento) : '—'),
        respLinha,
      ];
      break;
    case 'reserva':
      linhas = [
        ev.usuario_nome ? L('Leitor', ev.usuario_nome) : null,
        linhaLivro,
        L('Data da reserva', fmtData(ev.data_reserva)),
        L('Situação', ev.status),
        ev.fila != null ? L('Posição na fila', `${ev.fila}º`) : null,
        respLinha,
      ];
      break;
    case 'reserva_atendida':
    case 'reserva_cancelada':
      linhas = [ev.usuario_nome ? L('Leitor', ev.usuario_nome) : null, linhaLivro, L('Status', ev.status), respLinha];
      break;
    case 'cadastro':
      linhas = (ev.alteracoes || []).map((a) => L(a.campo, `${a.de || '—'} → ${a.para || '—'}`));
      linhas.push(respLinha);
      break;
    // livro_cadastro/exemplar_cadastro (19/07/2026, quinta rodada de
    // feedback: "o ISBN aparece duas vezes... também está repetido"): o
    // ISBN/código já aparece na linha-resumo colapsada (ver resumoEvento) —
    // repeti-lo aqui no detalhe expandido não acrescentava nada. Removidos;
    // sobra só o rodapé comum (Responsável/Horário).
    case 'livro_cadastro':
      linhas = [respLinha];
      break;
    case 'exemplar_cadastro':
      linhas = [respLinha];
      break;
    case 'exemplar_cadastro_lote':
      linhas = [L('Códigos', (ev.exemplares || []).join(', ')), respLinha];
      break;
    case 'status_alterado':
      linhas = [
        // "De" só aparece quando conhecido — registros antigos de auditoria
        // (antes do formato {alteracoes:[...]} existir) não têm esse dado.
        ev.de ? L('De', EXEMPLAR_STATUS_PT[ev.de] || ev.de) : null,
        L('Para', EXEMPLAR_STATUS_PT[ev.para] || ev.para),
        L('Motivo', ev.motivo),
        respLinha,
      ];
      break;
    default:
      linhas = [respLinha];
  }
  // Horário só aparece no detalhe expandido (16/07/2026: "a maioria dos
  // bibliotecários quer saber o dia, não a hora" — a hora some da linha
  // colapsada, ver renderLeitorTimeline, e fica disponível aqui).
  if (ev.quando) linhas.push(M('Horário', fmtHora(ev.quando)));
  return linhas.filter(Boolean);
}
// Renderiza o painel de detalhe expandido de um evento (19/07/2026, quinta
// rodada de feedback — "eu definiria um padrão... Todo evento teria:
// Título / Descrição curta / Detalhes / Responsável / Data / Hora"): um
// divisor visual marca a fronteira entre os campos específicos do evento
// (Detalhes) e o rodapé comum (Responsável/Horário, linhas com meta:true —
// ver detalhesEvento/detalhesEventoEmprestimo). Compartilhada por
// renderLeitorTimeline (Leitor/Livro) e renderEmprestimoTimeline
// (Empréstimo), para a mesma consistência valer em todas as entidades.
function linhasDetalheHTML(linhas) {
  let metaJaMarcado = false;
  return linhas
    .map((l) => {
      const divisor = l.meta && !metaJaMarcado;
      if (l.meta) metaJaMarcado = true;
      return `<div class="leitor-evento-detalhe-item${divisor ? ' leitor-evento-detalhe-item--divisor' : ''}"><span>${sanitize(l.label)}</span><strong>${sanitize(String(l.valor))}</strong></div>`;
    })
    .join('');
}
// Agrupa exemplares cadastrados em sequência (mesmo lote) num único evento
// "N exemplares cadastrados" — pedido de design de 16/07/2026 para reduzir
// ruído quando vários exemplares do mesmo livro são cadastrados de uma vez.
function agruparExemplaresCadastro(eventos) {
  const out = [];
  let i = 0;
  while (i < eventos.length) {
    const ev = eventos[i];
    if (ev.tipo === 'exemplar_cadastro') {
      const lote = [ev];
      let j = i + 1;
      while (j < eventos.length && eventos[j].tipo === 'exemplar_cadastro') {
        lote.push(eventos[j]);
        j++;
      }
      out.push(
        lote.length > 1
          ? {
              tipo: 'exemplar_cadastro_lote',
              quando: lote[0].quando,
              exemplares: lote.map((e) => e.exemplar),
              responsavel: lote[0].responsavel,
            }
          : ev,
      );
      i = j;
    } else {
      out.push(ev);
      i++;
    }
  }
  return out;
}

// Guarda o array bruto por elId para o botão "Ver histórico completo"
// re-renderizar sem limite, sem precisar de nova chamada ao backend.
const _timelineEstado = {};

// elId/mensagemVazia parametrizados para reaproveitar o mesmo renderer no
// histórico do Livro (livroDetalhe) — ver renderLivroTimeline logo abaixo.
// opts.contexto ('leitor'|'livro') esconde campos redundantes com a própria
// tela; opts.limite trunca a lista (mais recentes primeiro) e mostra um
// botão "Ver histórico completo" — pedido de design de 16/07/2026 para não
// exibir centenas de eventos de uma vez em livros/leitores muito movimentados.
// opts.expandidoPorPadrao (17/07/2026, feedback comparando o Detalhe do
// Exemplar acessado via Livros × via Exemplares): o histórico de UM único
// exemplar costuma ter poucos eventos, então não faz sentido escondê-los
// atrás de um clique por linha — diferente do histórico agregado de
// Livro/Leitor (que mistura vários exemplares/movimentações e continua
// colapsado por padrão, regra acima). É a mesma função/mesmo dado nos dois
// casos (ver abrirDetalheExemplar); só essa opção muda.
function renderLeitorTimeline(
  eventos,
  elId = 'leitorTimeline',
  mensagemVazia = 'Este leitor ainda não possui histórico de movimentações.',
  opts = {},
) {
  const { contexto = null, limite = null, expandidoPorPadrao = false } = opts;
  const el = document.getElementById(elId);
  if (!el) return;
  _timelineEstado[elId] = { eventos: eventos || [], mensagemVazia, contexto, expandidoPorPadrao };
  if (!eventos || !eventos.length) {
    el.innerHTML = `<p class="leitor-timeline-vazia">${mensagemVazia}</p>`;
    return;
  }
  const processados = agruparExemplaresCadastro(eventos);
  const truncado = limite != null && processados.length > limite;
  const exibidos = truncado ? processados.slice(0, limite) : processados;

  // Agrupa por dia — a ordenação (mais recente primeiro) já vem do backend.
  const grupos = [];
  let atual = null;
  for (const ev of exibidos) {
    const dia = String(ev.quando).split('T')[0];
    if (!atual || atual.dia !== dia) {
      atual = { dia, eventos: [] };
      grupos.push(atual);
    }
    atual.eventos.push(ev);
  }
  const html = grupos
    .map(
      (g) => `<div class="leitor-timeline-grupo">
        <div class="leitor-timeline-grupo-data">${tituloGrupoData(g.dia)}</div>
        <div class="leitor-timeline-eventos">
            ${g.eventos
              .map((ev) => {
                const linhas = detalhesEvento(ev, contexto);
                // Sem hora na linha colapsada (16/07/2026: "a maioria dos
                // bibliotecários quer saber o dia, não a hora" — a hora
                // passou a viver só no detalhe expandido, via detalhesEvento).
                return `<div class="leitor-evento${expandidoPorPadrao ? ' expandido' : ''}">
                <button type="button" class="leitor-evento-resumo" onclick="this.closest('.leitor-evento').classList.toggle('expandido')" aria-expanded="${expandidoPorPadrao ? 'true' : 'false'}">
                    <span class="leitor-evento-icone leitor-evento-icone--${ev.tipo}">${svgTimeline(ev.tipo)}</span>
                    <span class="leitor-evento-textos">
                        <span class="leitor-evento-titulo">${sanitize(tituloEvento(ev))}</span>
                        <span class="leitor-evento-subtitulo">${resumoEvento(ev)}</span>
                    </span>
                    <svg class="leitor-evento-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                <div class="leitor-evento-detalhe">
                    ${linhasDetalheHTML(linhas)}
                </div>
                </div>`;
              })
              .join('')}
        </div>
    </div>`,
    )
    .join('');
  el.innerHTML = truncado
    ? `${html}<button type="button" class="leitor-timeline-expandir" onclick="expandirTimelineCompleta('${elId}')">Ver histórico completo (${processados.length})</button>`
    : html;
}
// Botão "Ver histórico completo" — reaproveita o array já carregado em
// memória (sem nova chamada ao backend) e re-renderiza sem limite.
function expandirTimelineCompleta(elId) {
  const estado = _timelineEstado[elId];
  if (!estado) return;
  renderLeitorTimeline(estado.eventos, elId, estado.mensagemVazia, {
    contexto: estado.contexto,
    limite: null,
    expandidoPorPadrao: estado.expandidoPorPadrao,
  });
}
// Histórico do "Perfil do Livro" (redesenho de 14/07/2026, revisado em
// 16/07/2026) — mesmo renderer da Central do Leitor, só muda o elemento
// alvo, a mensagem de vazio e as opções de contexto/limite.
function renderLivroTimeline(eventos) {
  renderLeitorTimeline(eventos, 'livroDetalheTimeline', 'Este livro ainda não possui histórico de movimentações.', {
    contexto: 'livro',
    limite: 10,
  });
}

async function abrirDetalhesLeitor(id) {
  _leitorDetalheId = id;
  document.querySelectorAll('.action-menu.open').forEach((m) => m.classList.remove('open'));
  const { data: leitor, error } = await UsuarioRepo.detalhe(id);
  if (error || !leitor) {
    showAlert('usuarioAlert', 'Erro ao carregar detalhes do leitor.', 'error');
    return;
  }

  const avatarEl = document.getElementById('leitorDetalheAvatar');
  if (avatarEl) avatarEl.textContent = (leitor.nome || '?').trim()[0]?.toUpperCase() || '?';
  document.getElementById('leitorDetalheNome').textContent = leitor.nome || '—';
  document.getElementById('leitorDetalheStatus').innerHTML = leitor.ativo
    ? '<span class="badge badge-success">Ativa</span>'
    : '<span class="badge badge-danger">Inativa</span>';
  const mesAno = leitor.data_cadastro ? fmtMesAno(leitor.data_cadastro) : null;
  document.getElementById('leitorDetalheDesde').textContent = mesAno
    ? `Leitor(a) cadastrado(a) desde ${mesAno}`
    : 'Leitor(a) cadastrado(a) na biblioteca';

  document.getElementById('leitorDetalheCPF').textContent = fmtCPF(leitor.cpf) || '—';
  document.getElementById('leitorDetalheTelefone').textContent = fmtTelefone(leitor.telefone);
  document.getElementById('leitorDetalheEmail').textContent = leitor.email || '—';
  document.getElementById('leitorDetalheCadastro').textContent = leitor.data_cadastro
    ? fmtData(String(leitor.data_cadastro).split('T')[0])
    : '—';

  const resumo = leitor.resumo || {};
  document.getElementById('leitorResumoEmprestimos').textContent = resumo.emprestimosAtivos ?? 0;
  document.getElementById('leitorResumoReservas').textContent = resumo.reservasAtivas ?? 0;
  document.getElementById('leitorResumoMultas').textContent = resumo.multasPendentes ?? 0;

  renderLeitorTimeline(leitor.eventos || []);

  const escreve = podeEscrever();
  const btnEdit = document.getElementById('btnEditarDetalheLeitor');
  if (btnEdit) btnEdit.style.display = escreve ? '' : 'none';
  const btnEmp = document.getElementById('btnNovoEmprestimoDetalheLeitor');
  if (btnEmp) btnEmp.style.display = escreve && leitor.ativo ? '' : 'none';
  const btnRes = document.getElementById('btnNovaReservaDetalheLeitor');
  if (btnRes) btnRes.style.display = escreve && leitor.ativo ? '' : 'none';

  abrirModal('modalDetalhesLeitor');
}

/* ===== Leitor pré-selecionado nos formulários de Empréstimo/Reserva =====
 * Quando o bibliotecário chega a estas telas a partir da Central do Leitor
 * (botões "Novo Empréstimo"/"Nova Reserva"), o campo Leitor vem preenchido
 * e travado (mostrando o nome + botão "Alterar") em vez do <select> normal,
 * para não obrigar uma segunda seleção do mesmo leitor. Chegando pelo menu
 * lateral, o formulário continua abrindo vazio — resetLeitorFixo() garante
 * isso a cada showSection('emprestimos'|'reservas', ...). */
function resetLeitorFixo(prefixo) {
  const sel = document.getElementById(`${prefixo}Usuario`);
  const fixo = document.getElementById(`${prefixo}UsuarioFixo`);
  if (sel) sel.style.display = '';
  if (fixo) fixo.style.display = 'none';
}
function fixarLeitorNoFormulario(prefixo, leitorId, leitorNome) {
  if (!leitorId) return;
  const sel = document.getElementById(`${prefixo}Usuario`);
  const fixo = document.getElementById(`${prefixo}UsuarioFixo`);
  const fixoNome = document.getElementById(`${prefixo}UsuarioFixoNome`);
  if (!sel || !fixo || !fixoNome) return;
  sel.value = leitorId;
  fixoNome.textContent = leitorNome || '—';
  sel.style.display = 'none';
  fixo.style.display = 'flex';
}
// Botão "Alterar" do campo travado: volta a mostrar o <select> normal
// (o leitor pré-selecionado continua marcado nele) sem precisar fechar e
// reabrir o formulário.
function alterarLeitorFixo(prefixo) {
  const sel = document.getElementById(`${prefixo}Usuario`);
  const fixo = document.getElementById(`${prefixo}UsuarioFixo`);
  if (!sel || !fixo) return;
  fixo.style.display = 'none';
  sel.style.display = '';
  sel.focus();
}

// Ações rápidas do painel: fecha o modal, navega para a seção certa,
// aguarda o carregamento dos selects (agora que showSection retorna essa
// promise) e só então trava o campo Leitor preenchido, movendo o foco
// para o próximo campo do formulário (Livro/Exemplar).
async function novaAcaoParaLeitor(tipo) {
  const leitorId = _leitorDetalheId;
  const leitorNome = document.getElementById('leitorDetalheNome')?.textContent?.trim() || '';
  fecharModal('modalDetalhesLeitor');
  if (tipo === 'emprestimo') {
    // Empréstimo agora vive num modal (redesenho de 14/07/2026): navega para
    // a seção, abre o modal "Novo Empréstimo" (que por padrão reseta o campo
    // Leitor) e só então trava o leitor vindo da Central do Leitor — nessa
    // ordem, para não perder a trava logo em seguida. abrirModal() foca o
    // primeiro campo automaticamente após 50ms; aqui adiamos o foco para
    // além disso, para pousar em Livro (o leitor já está definido).
    await showSection('emprestimos', document.getElementById('nav-emprestimos'));
    abrirModalNovoEmprestimo();
    fixarLeitorNoFormulario('emprestimo', leitorId, leitorNome);
    setTimeout(() => document.getElementById('emprestimoLivro')?.focus(), 100);
  } else {
    await showSection('reservas', document.getElementById('nav-reservas'));
    fixarLeitorNoFormulario('reserva', leitorId, leitorNome);
    document.getElementById('reservaLivro')?.focus();
  }
}

async function updateUsuario() {
  const id = document.getElementById('editUsuarioId').value;
  const res = await UsuarioService.atualizar(id, {
    nome: val('editUsuarioNome'),
    email: val('editUsuarioEmail'),
    telefone: val('editUsuarioTelefone'),
  });
  showAlert('usuarioAlert', res.message, res.ok ? 'success' : 'error');
  if (!res.ok) return;
  fecharModal('modalUsuario');
  await reloadUsuarioSelects();
  await renderUsuarios();
}
async function desativarUsuario(id) {
  if (pendingOp) return;
  if (!confirm('Desativar este leitor? O histórico será preservado.')) return;
  pendingOp = true;
  const res = await UsuarioService.inativar(id);
  pendingOp = false;
  showAlert('usuarioAlert', res.message, res.ok ? 'success' : 'error');
  if (!res.ok) return;
  await reloadUsuarioSelects();
  loadUsuariosKpis();
  await renderUsuarios();
}
async function ativarUsuario(id) {
  if (pendingOp) return;
  pendingOp = true;
  const res = await UsuarioService.reativar(id);
  pendingOp = false;
  showAlert('usuarioAlert', res.message, res.ok ? 'success' : 'error');
  if (!res.ok) return;
  await reloadUsuarioSelects();
  loadUsuariosKpis();
  await renderUsuarios();
}

/* ===== CUSTOM SELECT (filtros livros) ===== */
function cselToggle(wrapId) {
  const wrap = document.getElementById(wrapId);
  const panel = wrap?.querySelector('.csel-panel');
  if (!wrap || !panel) return;
  const isOpen = wrap.classList.contains('csel-open');
  // Fecha todos os painéis abertos
  document.querySelectorAll('.csel-wrap.csel-open').forEach((w) => {
    w.querySelector('.csel-panel').style.display = 'none';
    w.classList.remove('csel-open');
    w.querySelector('.csel-trigger')?.setAttribute('aria-expanded', 'false');
  });
  if (isOpen) return;
  // Constrói lista de opções a partir do select oculto
  const sel = wrap.querySelector('select');
  panel.innerHTML = '';
  [...sel.options].forEach((o) => {
    const d = document.createElement('div');
    d.className = 'csel-option' + (sel.value === o.value ? ' csel-selected' : '');
    d.setAttribute('role', 'option');
    d.setAttribute('aria-selected', String(sel.value === o.value));
    d.textContent = o.text;
    d.onclick = () => cselSelect(wrapId, o.value, o.text);
    panel.appendChild(d);
  });
  panel.style.display = 'block';
  wrap.classList.add('csel-open');
  wrap.querySelector('.csel-trigger')?.setAttribute('aria-expanded', 'true');
}

function cselSelect(wrapId, value, text) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  wrap.querySelector('select').value = value;
  wrap.querySelector('.csel-label').textContent = text;
  wrap.querySelector('.csel-panel').style.display = 'none';
  wrap.classList.remove('csel-open');
  wrap.querySelector('.csel-trigger')?.setAttribute('aria-expanded', 'false');
  filterTable('livros');
}

function cselSyncFromHidden(wrapId) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const sel = wrap.querySelector('select');
  const cur = [...sel.options].find((o) => o.value === sel.value) || sel.options[0];
  if (cur) wrap.querySelector('.csel-label').textContent = cur.text;
}

/* ===== CHIP SELECT — seletor de autores com busca e chips ===== */
let _autoresData = [];
const chipState = {};

function chipInit(key, preSelected) {
  chipState[key] = { selected: preSelected ? preSelected.map((s) => ({ id: String(s.id), nome: s.nome })) : [] };
  const inp = document.getElementById(key + 'Input');
  if (!inp) return;
  inp.value = '';
  if (!inp._chipBound) {
    inp._chipBound = true;
    inp.addEventListener('input', () => _chipRefreshDrop(key));
    inp.addEventListener('focus', () => {
      _chipRefreshDrop(key);
      _chipShowDrop(key, true);
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') _chipShowDrop(key, false);
      if (e.key === 'Backspace' && !inp.value) {
        const sel = chipState[key]?.selected || [];
        if (sel.length) {
          sel.pop();
          _chipRenderChips(key);
          _chipSync(key);
        }
      }
    });
  }
  _chipRenderChips(key);
  _chipSync(key);
}

function _chipShowDrop(key, show) {
  const drop = document.getElementById(key + 'Drop');
  if (drop) drop.style.display = show ? 'block' : 'none';
}

// "+ Criar" (17/07/2026, criação rápida de dados auxiliares): quando o termo
// digitado não bate exatamente com nenhum autor já cadastrado, mostra uma
// linha de ação abrindo o mini-modal "Novo Autor" — o bibliotecário nunca
// precisa sair do cadastro do livro. Se já existe um autor com esse nome
// exato, a linha de criação some (evita duplicar).
function _chipRefreshDrop(key) {
  const inp = document.getElementById(key + 'Input');
  const drop = document.getElementById(key + 'Drop');
  if (!drop) return;
  const termoOriginal = (inp?.value || '').trim();
  const term = termoOriginal.toLowerCase();
  const selIds = (chipState[key]?.selected || []).map((s) => s.id);
  const filtered = _autoresData.filter((a) => !term || a.nome_autor.toLowerCase().includes(term)).slice(0, 30);
  const TICK =
    '<svg viewBox="0 0 10 7" fill="none" style="width:10px;height:7px"><polyline stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="1,3.5 3.5,6 9,1"/></svg>';
  const listaHTML = !filtered.length
    ? '<div class="chip-empty">Nenhum autor encontrado.</div>'
    : filtered
        .map((a) => {
          const id = String(a.autor_id);
          const isSel = selIds.includes(id);
          const nome = sanitize(a.nome_autor);
          return `<div class="chip-option${isSel ? ' selected' : ''}" onclick="chipToggle('${key}','${id}','${nome.replace(/'/g, '&#039;')}')">
                <span class="chip-check">${isSel ? TICK : ''}</span>${nome}</div>`;
        })
        .join('');
  const existeExato = _autoresData.some((a) => a.nome_autor.toLowerCase() === term);
  const criarLabel = termoOriginal ? `+ Criar "${sanitize(termoOriginal)}"` : '+ Novo Autor';
  const criarHTML = existeExato
    ? ''
    : `<div class="chip-option-divider"></div><div class="chip-option chip-option-criar" onclick="_chipAbrirCriarAutor('${key}')">${criarLabel}</div>`;
  drop.innerHTML = listaHTML + criarHTML;
  drop.style.display = 'block';
}

function _chipAbrirCriarAutor(key) {
  const inp = document.getElementById(key + 'Input');
  const termo = (inp?.value || '').trim();
  _chipShowDrop(key, false);
  abrirNovoAutor(termo, key);
}

function chipToggle(key, id, nome) {
  const sel = chipState[key]?.selected || [];
  const idx = sel.findIndex((s) => s.id === String(id));
  if (idx >= 0) sel.splice(idx, 1);
  else sel.push({ id: String(id), nome });
  _chipRenderChips(key);
  _chipSync(key);
  _chipRefreshDrop(key);
}

function chipRemove(key, id) {
  const sel = chipState[key]?.selected || [];
  const idx = sel.findIndex((s) => s.id === String(id));
  if (idx >= 0) {
    sel.splice(idx, 1);
    _chipRenderChips(key);
    _chipSync(key);
  }
}

function _chipRenderChips(key) {
  const el = document.getElementById(key + 'Chips');
  if (!el) return;
  const sel = chipState[key]?.selected || [];
  el.innerHTML = sel
    .map(
      (s) =>
        `<span class="chip-tag">${sanitize(s.nome)}<button type="button" class="chip-tag-remove" onclick="chipRemove('${key}','${sanitize(String(s.id))}')" aria-label="Remover ${sanitize(s.nome)}">&#215;</button></span>`,
    )
    .join('');
}

// Chaves corrigidas em 17/07/2026: eram 'novo'/'edit', mas os elementos reais
// no HTML são novoAutoresInput/novoAutoresChips/novoAutoresDrop (e
// editAutores*) — document.getElementById(key + 'Input') nunca resolvia
// 'novoInput'/'editInput' (que não existem), então o dropdown de busca de
// autor nunca inicializava (nenhum listener era ligado ao campo real). Bug
// pré-existente, encontrado ao mexer nesta função para a criação rápida.
function _chipSync(key) {
  const map = { novoAutores: 'livroAutores', editAutores: 'editLivroAutores' };
  const sel = document.getElementById(map[key]);
  if (!sel) return;
  const ids = (chipState[key]?.selected || []).map((s) => String(s.id));
  Array.from(sel.options).forEach((opt) => {
    opt.selected = ids.includes(String(opt.value));
  });
}

function chipGetIds(key) {
  return (chipState[key]?.selected || []).map((s) => s.id);
}

/* ---------- Novo Autor (criação rápida, 17/07/2026) ---------- */
let _novoAutorChipKey = null;
function abrirNovoAutor(termo, chipKey) {
  _novoAutorChipKey = chipKey;
  const nomeEl = document.getElementById('novoAutorNome');
  if (nomeEl) nomeEl.value = termo || '';
  const a = document.getElementById('novoAutorAlert');
  if (a) a.innerHTML = '';
  abrirModal('modalNovoAutor');
  setTimeout(() => nomeEl?.focus(), 60);
}
async function criarAutorRapido() {
  if (pendingOp) return;
  const nome = val('novoAutorNome');
  if (!nome) {
    showAlert('novoAutorAlert', 'Informe o nome do autor.', 'error');
    return;
  }
  pendingOp = true;
  const btn = document.getElementById('btnCriarAutor');
  if (btn) btn.disabled = true;
  const res = await CatalogoService.criarAutor(nome);
  if (btn) btn.disabled = false;
  pendingOp = false;
  if (!res.ok) {
    showAlert('novoAutorAlert', res.message, 'error');
    return;
  }
  const novo = { autor_id: res.data.autor_id, nome_autor: res.data.nome_autor };
  _autoresData.push(novo);
  _autoresData.sort((a, b) => a.nome_autor.localeCompare(b.nome_autor, 'pt-BR'));
  fecharModal('modalNovoAutor');
  if (_novoAutorChipKey) {
    const inp = document.getElementById(_novoAutorChipKey + 'Input');
    if (inp) inp.value = '';
    chipToggle(_novoAutorChipKey, novo.autor_id, novo.nome_autor);
  }
}

/* ---------- Combo select pesquisável com criação rápida (Categoria/Editora, 17/07/2026) ----------
   Diferente do chip-select (autor, multi-seleção com "chips" removíveis),
   Categoria e Editora são seleção única: digitar filtra a lista, clicar
   seleciona e escreve o nome no campo. Um <select> nativo oculto (o mesmo
   que já existia antes) continua sendo a fonte de verdade lida por
   createLivro()/updateLivro() via raw() — este componente só cuida da
   parte visual/pesquisável por cima dele. Igual ao chip-select, mostra
   "+ Criar" quando o termo digitado não bate com nenhum item existente. */
let _categoriasData = [];
let _editorasData = [];
const COMBO_FONTES = {
  categoria: {
    dados: () => _categoriasData,
    idKey: 'categoria_id',
    labelKey: 'nome_categoria',
    rotulo: 'Categoria',
    artigo: 'Nova',
    abrirCriar: (termo, comboKey) => abrirNovaCategoria(termo, comboKey),
  },
  editora: {
    dados: () => _editorasData,
    idKey: 'editora_id',
    labelKey: 'nome_editora',
    rotulo: 'Editora',
    artigo: 'Nova',
    abrirCriar: (termo, comboKey) => abrirNovaEditora(termo, comboKey),
  },
};
// key -> { fonte: 'categoria'|'editora', hiddenSelectId, id, label }
const comboState = {};

function comboInit(key, fonteNome, hiddenSelectId, valorId, valorLabel) {
  comboState[key] = { fonte: fonteNome, hiddenSelectId, id: valorId ? String(valorId) : '', label: valorLabel || '' };
  const inp = document.getElementById(key + 'Input');
  if (!inp) return;
  inp.value = valorLabel || '';
  _comboSyncHidden(key);
  if (!inp._comboBound) {
    inp._comboBound = true;
    inp.addEventListener('input', () => {
      comboState[key].id = '';
      comboState[key].label = inp.value;
      _comboSyncHidden(key);
      _comboRefreshDrop(key);
    });
    inp.addEventListener('focus', () => _comboRefreshDrop(key));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') _comboShowDrop(key, false);
    });
  }
}

function _comboShowDrop(key, show) {
  const drop = document.getElementById(key + 'Drop');
  if (drop) drop.style.display = show ? 'block' : 'none';
}

function _comboRefreshDrop(key) {
  const st = comboState[key];
  const fonte = COMBO_FONTES[st?.fonte];
  const inp = document.getElementById(key + 'Input');
  const drop = document.getElementById(key + 'Drop');
  if (!st || !fonte || !drop) return;
  const dados = fonte.dados();
  const termoOriginal = (inp?.value || '').trim();
  const term = termoOriginal.toLowerCase();
  const filtrados = dados.filter((d) => !term || String(d[fonte.labelKey]).toLowerCase().includes(term)).slice(0, 30);
  const TICK =
    '<svg viewBox="0 0 10 7" fill="none" style="width:10px;height:7px"><polyline stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="1,3.5 3.5,6 9,1"/></svg>';
  const listaHTML = !filtrados.length
    ? `<div class="chip-empty">Nenhuma ${fonte.rotulo.toLowerCase()} encontrada.</div>`
    : filtrados
        .map((d) => {
          const id = String(d[fonte.idKey]);
          const nome = sanitize(d[fonte.labelKey]);
          const isSel = st.id === id;
          return `<div class="chip-option${isSel ? ' selected' : ''}" onclick="comboSelecionar('${key}','${id}','${nome.replace(/'/g, '&#039;')}')">
                <span class="chip-check">${isSel ? TICK : ''}</span>${nome}</div>`;
        })
        .join('');
  const existeExato = dados.some((d) => String(d[fonte.labelKey]).toLowerCase() === term);
  const criarLabel = termoOriginal ? `+ Criar "${sanitize(termoOriginal)}"` : `+ ${fonte.artigo} ${fonte.rotulo}`;
  const criarHTML = existeExato
    ? ''
    : `<div class="chip-option-divider"></div><div class="chip-option chip-option-criar" onclick="_comboAbrirCriar('${key}')">${criarLabel}</div>`;
  drop.innerHTML = listaHTML + criarHTML;
  drop.style.display = 'block';
}

function comboSelecionar(key, id, nome) {
  const st = comboState[key];
  if (!st) return;
  st.id = String(id);
  st.label = nome;
  const inp = document.getElementById(key + 'Input');
  if (inp) inp.value = nome;
  _comboSyncHidden(key);
  _comboShowDrop(key, false);
}

function _comboSyncHidden(key) {
  const st = comboState[key];
  if (!st) return;
  const sel = document.getElementById(st.hiddenSelectId);
  if (!sel) return;
  sel.value = st.id || '';
}

function _comboAbrirCriar(key) {
  const st = comboState[key];
  const fonte = COMBO_FONTES[st?.fonte];
  if (!st || !fonte) return;
  const inp = document.getElementById(key + 'Input');
  const termo = (inp?.value || '').trim();
  _comboShowDrop(key, false);
  fonte.abrirCriar(termo, key);
}

/* ---------- Nova Categoria (criação rápida, 17/07/2026) ---------- */
let _novaCategoriaComboKey = null;
function abrirNovaCategoria(termo, comboKey) {
  _novaCategoriaComboKey = comboKey;
  document.getElementById('novaCategoriaNome').value = termo || '';
  document.getElementById('novaCategoriaDescricao').value = '';
  const a = document.getElementById('novaCategoriaAlert');
  if (a) a.innerHTML = '';
  abrirModal('modalNovaCategoria');
  setTimeout(() => document.getElementById('novaCategoriaNome')?.focus(), 60);
}
async function criarCategoriaRapida() {
  if (pendingOp) return;
  const nome = val('novaCategoriaNome');
  if (!nome) {
    showAlert('novaCategoriaAlert', 'Informe o nome da categoria.', 'error');
    return;
  }
  const descricao = val('novaCategoriaDescricao') || null;
  pendingOp = true;
  const btn = document.getElementById('btnCriarCategoria');
  btn.disabled = true;
  const res = await CatalogoService.criarCategoria(nome, descricao);
  btn.disabled = false;
  pendingOp = false;
  if (!res.ok) {
    showAlert('novaCategoriaAlert', res.message, 'error');
    return;
  }
  const nova = { categoria_id: res.data.categoria_id, nome_categoria: res.data.nome_categoria };
  _categoriasData.push(nova);
  _categoriasData.sort((a, b) => a.nome_categoria.localeCompare(b.nome_categoria, 'pt-BR'));
  fecharModal('modalNovaCategoria');
  if (_novaCategoriaComboKey) comboSelecionar(_novaCategoriaComboKey, nova.categoria_id, nova.nome_categoria);
  // Mantém o filtro de Categoria da tela de Livros em sincronia (Achado 24).
  const filtCatEl = document.getElementById('livroFiltroCategoria');
  if (filtCatEl) {
    filtCatEl.innerHTML =
      '<option value="">Categoria</option>' +
      _categoriasData.map((c) => `<option value="${c.categoria_id}">${sanitize(c.nome_categoria)}</option>`).join('');
    cselSyncFromHidden('cselLivroCategoria');
  }
}

/* ---------- Nova Editora (criação rápida, 17/07/2026) ---------- */
let _novaEditoraComboKey = null;
function abrirNovaEditora(termo, comboKey) {
  _novaEditoraComboKey = comboKey;
  document.getElementById('novaEditoraNome').value = termo || '';
  document.getElementById('novaEditoraSite').value = '';
  document.getElementById('novaEditoraCidade').value = '';
  const a = document.getElementById('novaEditoraAlert');
  if (a) a.innerHTML = '';
  abrirModal('modalNovaEditora');
  setTimeout(() => document.getElementById('novaEditoraNome')?.focus(), 60);
}
async function criarEditoraRapida() {
  if (pendingOp) return;
  const nome = val('novaEditoraNome');
  if (!nome) {
    showAlert('novaEditoraAlert', 'Informe o nome da editora.', 'error');
    return;
  }
  const site = val('novaEditoraSite') || null;
  const cidade = val('novaEditoraCidade') || null;
  pendingOp = true;
  const btn = document.getElementById('btnCriarEditora');
  btn.disabled = true;
  const res = await CatalogoService.criarEditora(nome, site, cidade);
  btn.disabled = false;
  pendingOp = false;
  if (!res.ok) {
    showAlert('novaEditoraAlert', res.message, 'error');
    return;
  }
  const nova = { editora_id: res.data.editora_id, nome_editora: res.data.nome_editora };
  _editorasData.push(nova);
  _editorasData.sort((a, b) => a.nome_editora.localeCompare(b.nome_editora, 'pt-BR'));
  fecharModal('modalNovaEditora');
  if (_novaEditoraComboKey) comboSelecionar(_novaEditoraComboKey, nova.editora_id, nova.nome_editora);
  // Mantém o filtro de Editora da tela de Livros em sincronia (Achado 24).
  const filtEdEl = document.getElementById('livroFiltroEditora');
  if (filtEdEl) {
    filtEdEl.innerHTML =
      '<option value="">Editora</option>' +
      _editorasData.map((e) => `<option value="${e.editora_id}">${sanitize(e.nome_editora)}</option>`).join('');
    cselSyncFromHidden('cselLivroEditora');
  }
}

/* ---------- Livros ---------- */
function abrirModalNovoLivro() {
  ['livroTitulo', 'livroISBN', 'livroAno'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  comboInit('comboNovoCategoria', 'categoria', 'livroCategoria', '', '');
  comboInit('comboNovoEditora', 'editora', 'livroEditora', '', '');
  const a = document.getElementById('livroModalAlert');
  if (a) a.innerHTML = '';
  chipInit('novoAutores', []);
  abrirModal('modalNovoLivro');
}

// Badge de disponibilidade — tabela de Livros. Revisado em 16/07/2026:
// antes misturava três formatos ("Indisponível" / "Disponível" / "1/2
// disponíveis") dependendo do caso; feedback de design pediu um único
// formato consistente ("X/Y") com a cor do badge carregando o status.
function disponibilidadeBadgeHTML(disp, total) {
  if (!total) return `<span class="badge badge-neutro" title="Sem exemplares cadastrados">0/0</span>`;
  const classe = disp === 0 ? 'danger' : disp === total ? 'success' : 'warning';
  const titulo =
    disp === 0
      ? 'Indisponível'
      : disp === total
        ? 'Todos os exemplares disponíveis'
        : `${disp} de ${total} exemplares disponíveis`;
  return `<span class="badge badge-${classe}" title="${titulo}">${disp}/${total}</span>`;
}
// Coluna Reservas da tabela de Livros (19/07/2026, quinta rodada de
// feedback): antes vinha embutida como um chip dentro da célula de
// Título/Autores ("misturava identificação do livro com circulação",
// nas palavras do usuário) — agora é sua própria coluna, um pouco no
// mesmo espírito da separação Situação/Detalhe já aplicada a
// Empréstimos e Exemplares. Só o número (sem exemplares, não há fila).
function reservasColunaHTML(count) {
  if (!count) return '&#8212;';
  return `<span class="badge-reserva-count" title="${count} reserva${count === 1 ? '' : 's'} ativa${count === 1 ? '' : 's'}">${count}</span>`;
}
// Versão "pill" do cabeçalho do painel de Detalhes do Livro — revisada em
// 19/07/2026 (quinta rodada de feedback: "Disponibilidade" como rótulo
// era óbvio pelo contexto — é o único indicador do cabeçalho — e repetir
// a fração ("0/1") ao lado da palavra de status ("Indisponível") dizia a
// mesma coisa duas vezes, o mesmo tipo de redundância já apontada na
// tabela. Agora é só o status (cor + palavra) mais uma frase natural com
// a contagem embutida ("0 de 1 exemplar disponível"), sem repetir o "0/1"
// como um número solto ao lado.
function disponibilidadeStatusHTML(disp, total) {
  let classe = 'neutro',
    status = 'Sem exemplares',
    detalhe = 'Nenhum exemplar cadastrado';
  if (total) {
    if (disp === 0) {
      classe = 'danger';
      status = 'Indisponível';
    } else if (disp === total) {
      classe = 'success';
      status = 'Disponível';
    } else {
      classe = 'warning';
      status = 'Parcialmente disponível';
    }
    const substantivo = total === 1 ? 'exemplar disponível' : 'exemplares disponíveis';
    detalhe = `${disp} de ${total} ${substantivo}`;
  }
  return `<div class="livro-disponibilidade-status livro-disponibilidade-status--${classe}">
        <span class="livro-disponibilidade-status-texto">${status}</span>
        <span class="livro-disponibilidade-status-detalhe">${detalhe}</span>
    </div>`;
}
async function renderLivros() {
  const term = searchTerm('livrosSearch');
  const filtCat = document.getElementById('livroFiltroCategoria')?.value || '';
  const filtEd = document.getElementById('livroFiltroEditora')?.value || '';
  const filtDsp = document.getElementById('livroFiltroDisponibilidade')?.value || '';
  const CM = "document.querySelectorAll('.action-menu.open').forEach(m=>m.classList.remove('open'))";
  const BOOK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
  const temFiltros = term || filtCat || filtEd || filtDsp;
  await renderPaginado({
    tbodyId: 'livrosTable',
    paginationId: 'livrosPagination',
    colspan: 6,
    section: 'livros',
    loadingMsg: 'Carregando acervo...',
    fetch: () => LivroRepo.pagina({ page: pageState.livros, pageSize: PAGE_SIZE, q: term }),
    filterRows: (rows) => {
      if (filtCat) rows = rows.filter((l) => String(l.categoria_id) === filtCat);
      if (filtEd) rows = rows.filter((l) => String(l.editora_id) === filtEd);
      if (filtDsp === 'disponiveis') rows = rows.filter((l) => (l.disp || 0) > 0);
      if (filtDsp === 'sem_exemplares') rows = rows.filter((l) => (l.total_ex || 0) === 0);
      return rows;
    },
    emptyTd: () =>
      `<div class="livros-empty-inner">${BOOK_SVG}<p>${temFiltros ? 'Nenhum livro encontrado.' : 'Nenhum livro cadastrado.'}</p><small>${temFiltros ? 'Tente outros termos ou remova os filtros.' : 'Clique em <strong>Novo Livro</strong> para adicionar o primeiro livro ao acervo.'}</small></div>`,
    // Coluna Exemplares desmembrada em Disponibilidade + Reservas (19/07/2026,
    // quinta rodada de feedback): "capacidade, disponibilidade e empréstimos"
    // misturados numa célula só ("visualmente pesado", nas palavras do
    // usuário) viram duas colunas enxutas — a tabela responde só "posso
    // emprestar esse livro agora?"; os números completos (total/emprestados/
    // baixados) ficam no Detalhe do Livro, já reorganizado no bloco Resumo.
    rowFn: (l) => {
      const totalEx = l.total_ex || 0;
      const disp = l.disp || 0;
      // "Ver detalhes" foi removido do menu de três pontos (ficaria redundante
      // com o clique na linha, que já abre os mesmos detalhes) — crítica final
      // do pedido de 14/07/2026. O menu passa a ter só ações administrativas.
      const acoes = podeEscrever()
        ? `<div class="action-menu-wrap">
                <button class="btn-icon" onclick="toggleActionMenu(this)" title="Ações" aria-haspopup="true" aria-label="Ações">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                </button>
                <div class="action-menu" role="menu">
                    <button role="menuitem" onclick="${CM};openEditLivro(this.closest('tr').dataset.id)">Editar</button>
                    <button role="menuitem" onclick="${CM};abrirGerenciarExemplares(this.closest('tr').dataset.id)">Controle de Exemplares</button>
                    <div class="action-menu-divider"></div>
                    <button role="menuitem" class="action-menu-item--danger" onclick="${CM};deleteLivro(this.closest('tr').dataset.id)">Excluir</button>
                </div>
               </div>`
        : '&#8212;';
      return `<tr class="livro-row" data-id="${l.livro_id}" onclick="abrirDetalhesLivro(this.dataset.id)">
            <td data-label="Livro">
                <span class="livro-titulo-cell">${destacarTrecho(l.titulo, term)}</span>
                <br><span class="livro-autor-cell">${destacarTrecho(l.autores, term) || ''}</span>
            </td>
            <td data-label="Categoria">${l.nome_categoria ? `<span class="chip chip-categoria">${sanitize(l.nome_categoria)}</span>` : '&#8212;'}</td>
            <td data-label="Editora"><span class="livro-editora-cell">${sanitize(l.nome_editora) || '&#8212;'}</span></td>
            <td data-label="Disponibilidade">${disponibilidadeBadgeHTML(disp, totalEx)}</td>
            <td data-label="Reservas">${reservasColunaHTML(l.reservas_ativas || 0)}</td>
            <td class="td-actions" onclick="event.stopPropagation()">${acoes}</td>
        </tr>`;
    },
  });
}

async function createLivro() {
  if (pendingOp) return;
  const dados = {
    titulo: val('livroTitulo'),
    isbn: val('livroISBN'),
    ano: parseInt(raw('livroAno')) || null,
    categoria_id: raw('livroCategoria'),
    editora_id: raw('livroEditora'),
    autoresIds: chipGetIds('novoAutores'),
  };
  pendingOp = true;
  const btn = document.getElementById('btnCadLivro');
  btn.disabled = true;
  const res = await LivroService.criar(dados);
  btn.disabled = false;
  pendingOp = false;
  showAlert('livroModalAlert', res.message, res.ok ? 'success' : 'error');
  if (!res.ok) return;
  fecharModal('modalNovoLivro');
  showAlert('livroAlert', res.message, 'success');
  pageState.livros = 1;
  await reloadLivroSelects();
  await renderLivros();
}

async function openEditLivro(livro_id) {
  // Salva filtros ativos antes de recarregar selects (loadSelects recria os dropdowns)
  const _fc = document.getElementById('livroFiltroCategoria')?.value;
  const _fe = document.getElementById('livroFiltroEditora')?.value;
  const _fd = document.getElementById('livroFiltroDisponibilidade')?.value;
  await loadSelects();
  if (_fc != null && document.getElementById('livroFiltroCategoria')) {
    document.getElementById('livroFiltroCategoria').value = _fc;
    cselSyncFromHidden('cselLivroCategoria');
  }
  if (_fe != null && document.getElementById('livroFiltroEditora')) {
    document.getElementById('livroFiltroEditora').value = _fe;
    cselSyncFromHidden('cselLivroEditora');
  }
  if (_fd != null && document.getElementById('livroFiltroDisponibilidade')) {
    document.getElementById('livroFiltroDisponibilidade').value = _fd;
    cselSyncFromHidden('cselLivroDisp');
  }
  const { data: livro, error } = await LivroRepo.obterParaEdicao(livro_id);
  if (error || !livro) {
    showAlert('livroAlert', 'Erro ao carregar livro.', 'error');
    return;
  }
  document.getElementById('editLivroId').value = livro.livro_id;
  document.getElementById('editLivroTitulo').value = livro.titulo;
  document.getElementById('editLivroISBN').value = livro.isbn;
  document.getElementById('editLivroAno').value = livro.ano_publicacao || '';
  const catAtual = _categoriasData.find((c) => String(c.categoria_id) === String(livro.categoria_id));
  const edAtual = _editorasData.find((e) => String(e.editora_id) === String(livro.editora_id));
  comboInit(
    'comboEditCategoria',
    'categoria',
    'editLivroCategoria',
    livro.categoria_id,
    catAtual?.nome_categoria || '',
  );
  comboInit('comboEditEditora', 'editora', 'editLivroEditora', livro.editora_id, edAtual?.nome_editora || '');
  const idsAtuais = (livro.livro_autor || []).map((la) => String(la.autor_id));
  const preSelected = _autoresData
    .filter((a) => idsAtuais.includes(String(a.autor_id)))
    .map((a) => ({ id: String(a.autor_id), nome: a.nome_autor }));
  chipInit('editAutores', preSelected);
  const editAlert = document.getElementById('livroEditAlert');
  if (editAlert) editAlert.innerHTML = '';
  abrirModal('modalLivro');
}

async function updateLivro() {
  const dados = {
    titulo: val('editLivroTitulo'),
    isbn: val('editLivroISBN'),
    ano: parseInt(raw('editLivroAno')) || null,
    categoria_id: raw('editLivroCategoria'),
    editora_id: raw('editLivroEditora'),
    autoresIds: chipGetIds('editAutores'),
  };
  const id = document.getElementById('editLivroId').value;
  const btn = document.getElementById('btnSalvarLivro');
  btn.disabled = true;
  const res = await LivroService.atualizar(id, dados);
  btn.disabled = false;
  if (!res.ok) {
    showAlert('livroEditAlert', res.message, 'error');
    return;
  }
  fecharModal('modalLivro');
  showAlert('livroAlert', res.message, 'success');
  await reloadLivroSelects();
  await renderLivros();
}

/* --- Detalhes & Exclusão de Livros --- */
let _livroDetalheId = null;
// Guarda o objeto completo retornado por livroDetalhe (inclui eventos e
// exemplares) para telas derivadas — hoje o drill-down por exemplar — lerem
// sem precisar de uma nova chamada ao backend. Ver abrirDetalheExemplar.
let _livroDetalheCache = null;
let _pendingDeleteId = null;

// Rótulos e cores do status do exemplar — fonte única, usada em toda a
// aplicação (tabela de Exemplares, cards do Detalhe do Livro, Gerenciar
// Exemplares, Detalhe do Exemplar). Revisado em 16/07/2026 (reforma da tela
// de Exemplares): novo status Manutenção (cinza/neutro); Baixado deixou de
// ser neutro e passou a "danger" (vinho) — inversão explícita do esquema
// anterior, pedida no feedback de design ("Disponível verde / Emprestado
// dourado / Baixado vinho / Manutenção cinza"). "Reservado" nunca chegou a
// ser usado como status real de exemplar (não há fluxo que o atribua) e
// saiu do mapa.
const EXEMPLAR_STATUS_PT = {
  Disponivel: 'Disponível',
  Emprestado: 'Emprestado',
  Manutencao: 'Manutenção',
  Baixado: 'Baixado',
};
const EXEMPLAR_BADGE_CLASSE = { Disponivel: 'success', Emprestado: 'warning', Manutencao: 'neutro', Baixado: 'danger' };
// "Atrasado" deixou de ser um pseudo-status do badge em 19/07/2026 (feedback
// de design): "o exemplar continua emprestado — quem está atrasado é o
// empréstimo". Situação volta a refletir só o estado físico real
// (Disponível/Emprestado/Manutenção/Baixado); o atraso passou a viver só na
// coluna Detalhe (ver detalheExemplarColuna, logo abaixo). Substitui o
// esquema anterior (17/07/2026) que usava .badge-overdue para esse caso —
// a classe continua na folha de estilo, ainda usada pela tela de Multas.
function situacaoExemplarBadge(ex) {
  return { texto: EXEMPLAR_STATUS_PT[ex.status] || ex.status, classe: EXEMPLAR_BADGE_CLASSE[ex.status] || 'info' };
}
// Coluna "Detalhe" da tabela principal de Exemplares (19/07/2026, feedback
// de design): "Situação" virou só o estado físico (badge acima); o que está
// acontecendo agora — leitor/prazo/atraso do empréstimo atual, motivo/data
// da baixa — mora aqui, como uma única linha de texto contextual por status.
// updated_at (vw_exemplares_lista) funciona como "última alteração de
// status" porque é o único UPDATE que a aplicação faz em `exemplar`.
// Revisado em 19/07/2026 (sexta rodada de feedback): Baixado agora mostra
// data E motivo juntos (antes era um ou outro, dependendo se a data
// existia) — as duas informações são independentes e ambas relevantes.
// Emprestado/Atrasado trocou o separador "•" por duas linhas (<br>) — texto
// mais longo (nome + atraso) ficava apertado numa linha só. Disponível
// ganhou o texto completo "Disponível para empréstimo" em vez do genérico
// "Pronto para empréstimo". O `<br>` é seguro aqui porque o retorno vai
// para dentro de `<span class="dias-info">` via innerHTML (ver
// renderExemplares), sem sanitize() adicional no meio.
function detalheExemplarColuna(ex) {
  if (ex.status === 'Baixado') {
    const data = ex.updated_at ? fmtData(String(ex.updated_at).split('T')[0]) : null;
    const motivo = ex.motivo_baixa ? sanitize(ex.motivo_baixa) : null;
    if (data && motivo) return `Baixado em ${data}<br>Motivo: ${motivo}`;
    if (data) return `Baixado em ${data}`;
    return motivo ? `Motivo: ${motivo}` : 'Baixado';
  }
  if (ex.status === 'Manutencao') {
    const data = ex.updated_at ? fmtData(String(ex.updated_at).split('T')[0]) : null;
    return data ? `Em manutenção desde ${data}` : 'Em manutenção';
  }
  if (ex.status === 'Emprestado') {
    const nome = ex.usuario_nome ? sanitize(ex.usuario_nome) : 'Leitor';
    if (ex.atrasado && ex.dias_atraso) {
      return `${nome}<br>${ex.dias_atraso} dia${ex.dias_atraso === 1 ? '' : 's'} de atraso`;
    }
    if (ex.data_prevista) return `${nome}<br>devolução ${fmtData(ex.data_prevista)}`;
    return nome;
  }
  return 'Disponível para empréstimo';
}
// Ordem de exibição por status no modal Controle de Exemplares (19/07/2026,
// oitava rodada de feedback — "o bibliotecário normalmente quer encontrar
// primeiro os exemplares utilizáveis"): Disponível e Emprestado primeiro
// (ainda em circulação de verdade), Manutenção e Baixado por último (fora de
// uso). Grupos sem nenhum exemplar simplesmente não aparecem.
const EXEMPLAR_GERENCIAR_ORDEM = ['Disponivel', 'Emprestado', 'Manutencao', 'Baixado'];
const EXEMPLAR_GERENCIAR_GRUPO_TITULO = {
  Disponivel: 'Disponíveis',
  Emprestado: 'Emprestados',
  Manutencao: 'Em manutenção',
  Baixado: 'Baixados',
};
// Info contextual do card de exemplar (19/07/2026, oitava rodada de
// feedback — "cada status deveria mostrar informações diferentes" / "não
// mostrar sempre Motivo, só faz sentido quando está baixado"): um bloco
// .detalhe-item por campo relevante ao status atual, reaproveitando o mesmo
// par rótulo/valor já usado no bloco Resumo dos modais de Empréstimo/
// Exemplar — mesma informação de detalheExemplarColuna (tabela principal de
// Exemplares), só que como campos rotulados em vez de texto corrido.
function exemplarGerenciarInfoHTML(ex) {
  const item = (label, valor) =>
    `<div class="detalhe-item"><span class="detalhe-label">${label}</span><span class="detalhe-valor">${valor}</span></div>`;
  if (ex.status === 'Baixado') {
    const blocos = [];
    if (ex.motivo_baixa) blocos.push(item('Motivo da baixa', sanitize(ex.motivo_baixa)));
    if (ex.updated_at) blocos.push(item('Baixado em', fmtData(String(ex.updated_at).split('T')[0])));
    return blocos.join('');
  }
  if (ex.status === 'Manutencao') {
    return ex.updated_at ? item('Em manutenção desde', fmtData(String(ex.updated_at).split('T')[0])) : '';
  }
  if (ex.status === 'Emprestado') {
    const nome = ex.usuario_nome ? sanitize(ex.usuario_nome) : 'Leitor';
    const blocos = [item('Emprestado para', nome)];
    if (ex.atrasado && ex.dias_atraso) {
      blocos.push(item('Atraso', `${ex.dias_atraso} dia${ex.dias_atraso === 1 ? '' : 's'}`));
    } else if (ex.data_prevista) {
      blocos.push(item('Previsão', fmtData(ex.data_prevista)));
    }
    return blocos.join('');
  }
  return '<p class="exemplar-gerenciar-disponivel">Pronto para empréstimo.</p>';
}
// Cards do modal Controle de Exemplares, agrupados por status (19/07/2026,
// oitava rodada de feedback — "ainda parece um CRUD de exemplares, não um
// gerenciador"): substitui a antiga lista de linhas simples (código + botões
// de texto soltos) por cards com menu kebab, no mesmo padrão de Ver
// detalhes/Alterar status/Excluir já usado na tabela principal de
// Exemplares — inclusive o mesmo tratamento de Emprestado (ações
// desabilitadas com tooltip em vez de escondidas, já que a linha some da
// lista assim que o exemplar é devolvido, então não há razão pra esconder).
function renderExemplaresGerenciarCards(exemplares, container) {
  if (!container) return;
  if (!exemplares || !exemplares.length) {
    container.innerHTML = '<p class="livro-lista-vazia">Nenhum exemplar cadastrado.</p>';
    return;
  }
  const CM = "document.querySelectorAll('.action-menu.open').forEach(m=>m.classList.remove('open'))";
  const grupos = EXEMPLAR_GERENCIAR_ORDEM.map((status) => ({
    status,
    itens: exemplares.filter((ex) => ex.status === status),
  })).filter((g) => g.itens.length);

  container.innerHTML = grupos
    .map((g) => {
      const cards = g.itens
        .map((ex) => {
          const sit = situacaoExemplarBadge(ex);
          const codigoSan = sanitize(ex.codigo_patrimonial);
          const itensMenu =
            ex.status !== 'Emprestado'
              ? `<button role="menuitem" onclick="${CM};abrirDetalheExemplar('${ex.exemplar_id}', true)">Ver detalhes</button>
                 <div class="action-menu-divider"></div>
                 <button role="menuitem" onclick="${CM};abrirAlterarStatusExemplarGerenciar('${ex.exemplar_id}', '${codigoSan}', '${ex.status}')">Alterar status</button>
                 <div class="action-menu-divider"></div>
                 <button role="menuitem" class="action-menu-item--danger" onclick="${CM};deleteExemplar('${ex.exemplar_id}', true)">Excluir</button>`
              : `<button role="menuitem" onclick="${CM};abrirDetalheExemplar('${ex.exemplar_id}', true)">Ver detalhes</button>
                 <div class="action-menu-divider"></div>
                 <button role="menuitem" disabled title="Registre a devolução antes de alterar o status ou excluir">Alterar status</button>
                 <div class="action-menu-divider"></div>
                 <button role="menuitem" disabled title="Registre a devolução antes de alterar o status ou excluir">Excluir</button>`;
          return `<div class="exemplar-gerenciar-card">
              <div class="exemplar-gerenciar-card-topo">
                <span class="codigo-patrimonial">${codigoSan}</span>
                <span class="badge badge-${sit.classe}">${sanitize(sit.texto)}</span>
                <div class="action-menu-wrap">
                  <button class="btn-icon" onclick="toggleActionMenu(this)" title="Ações" aria-haspopup="true" aria-label="Ações">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                  </button>
                  <div class="action-menu" role="menu">${itensMenu}</div>
                </div>
              </div>
              <div class="exemplar-gerenciar-card-info">${exemplarGerenciarInfoHTML(ex)}</div>
            </div>`;
        })
        .join('');
      return `<div class="exemplar-gerenciar-grupo">
          <p class="exemplar-gerenciar-grupo-titulo">${EXEMPLAR_GERENCIAR_GRUPO_TITULO[g.status]} (${g.itens.length})</p>
          <div class="exemplar-gerenciar-grupo-cards">${cards}</div>
        </div>`;
    })
    .join('');
}

// Cards de exemplar (16/07/2026, read-only) — versão do painel de Detalhes
// do Livro. Cada card é clicável e abre o histórico daquele exemplar
// específico (abrirDetalheExemplar, sempre via backend desde a reforma da
// tela de Exemplares — ver exemplarDetalhe).
function renderExemplaresCards(exemplares, container, eventos = []) {
  if (!container) return;
  if (!exemplares || !exemplares.length) {
    container.innerHTML = '<p class="livro-lista-vazia">Nenhum exemplar cadastrado.</p>';
    return;
  }
  // Data do último empréstimo + total de empréstimos por exemplar (16/07 e
  // 19/07/2026) — calculados a partir da timeline já carregada (eventos vêm
  // do mais recente para o mais antigo), sem chamada nova ao backend.
  // Revisado em 19/07/2026 (quinta rodada de feedback): o card antes também
  // mostrava um número solto sem rótulo (reservaIndicadorHTML) que o
  // usuário leu como "provavelmente empréstimos" — na verdade era a
  // contagem de reservas do livro, já repetida no chip "Reservas" do
  // Resumo e na lista de Reservas ao lado. Removido daqui (redundante) e
  // substituído pelo número que realmente faltava: total de empréstimos
  // deste exemplar específico, ao lado da data do último.
  const ultimoEmprestimoPorExemplar = {};
  const totalEmprestimosPorExemplar = {};
  for (const ev of eventos) {
    if (ev.tipo === 'emprestimo' && ev.exemplar) {
      if (!ultimoEmprestimoPorExemplar[ev.exemplar]) ultimoEmprestimoPorExemplar[ev.exemplar] = ev.quando;
      totalEmprestimosPorExemplar[ev.exemplar] = (totalEmprestimosPorExemplar[ev.exemplar] || 0) + 1;
    }
  }
  container.innerHTML = exemplares
    .map((ex) => {
      const sit = situacaoExemplarBadge(ex);
      // 18/07/2026: as linhas de Com/Até/Atraso saíram daqui — esse card já
      // é clicável e leva ao modal de detalhe (abrirDetalheExemplar), que
      // mostra tudo. "Último empréstimo"/"Total de empréstimos" continuam:
      // não são redundantes com o modal quando o exemplar está disponível/
      // baixado (não há empréstimo atual pra mostrar lá).
      let info = '';
      const total = totalEmprestimosPorExemplar[ex.codigo_patrimonial] || 0;
      if (ex.status !== 'Emprestado' && total) {
        const ultimo = ultimoEmprestimoPorExemplar[ex.codigo_patrimonial];
        info = `<span class="exemplar-card-info">Último empréstimo ${fmtData(String(ultimo).split('T')[0])}<br>Total de empréstimos: ${total}</span>`;
      }
      return `<button type="button" class="exemplar-card" onclick="abrirDetalheExemplar('${ex.exemplar_id}', true)">
            <span class="exemplar-card-codigo codigo-patrimonial">${sanitize(ex.codigo_patrimonial)}</span>
            <span class="badge badge-${sit.classe}">${sanitize(sit.texto)}</span>
            ${info}
            <span class="exemplar-card-acao">Ver detalhes</span>
        </button>`;
    })
    .join('');
}

// Bloco "Circulação" do Detalhe do Livro — tudo calculado no cliente a
// partir do array de eventos que livroDetalhe já retorna, sem endpoint novo.
// Revisado em 16/07/2026: "Última movimentação" genérica virou "Última
// devolução" + "Última reserva" (junto de "Último empréstimo"), que o
// feedback de design considerou "muito mais útil".
// Tipos considerados "movimentação" para fins de Última movimentação —
// tudo que representa circulação de verdade (não cadastro/baixa/multa).
const TIPOS_MOVIMENTACAO = new Set(['emprestimo', 'devolucao', 'reserva', 'reserva_atendida', 'reserva_cancelada']);
function computarCirculacao(eventos) {
  const emprestimos = eventos.filter((e) => e.tipo === 'emprestimo');
  const devolucoes = eventos.filter((e) => e.tipo === 'devolucao');
  const reservas = eventos.filter((e) => e.tipo === 'reserva');
  return {
    totalEmprestimos: emprestimos.length,
    devolucoesNoPrazo: devolucoes.filter((e) => !(e.dias_atraso > 0)).length,
    devolucoesAtrasadas: devolucoes.filter((e) => e.dias_atraso > 0).length,
    // eventos já vêm ordenados do mais recente para o mais antigo (backend).
    ultimoEmprestimo: emprestimos[0] || null,
    ultimaDevolucao: devolucoes[0] || null,
    ultimaReserva: reservas[0] || null,
    // "Última movimentação" (19/07/2026, quinta rodada de feedback): resumo
    // de um único evento, o mais recente de qualquer tipo de circulação —
    // "ela resume tudo", nas palavras do usuário — antes das 3 linhas
    // específicas (que continuam existindo, mais detalhadas).
    ultimaMovimentacao: eventos.find((e) => TIPOS_MOVIMENTACAO.has(e.tipo)) || null,
  };
}

async function abrirDetalhesLivro(id) {
  _livroDetalheId = id;
  document.querySelectorAll('.action-menu.open').forEach((m) => m.classList.remove('open'));
  const { data: livro, error } = await LivroRepo.detalhe(id);
  if (error || !livro) {
    showAlert('livroAlert', 'Erro ao carregar detalhes.', 'error');
    return;
  }
  _livroDetalheCache = livro;

  document.getElementById('detalheTitulo').textContent = livro.titulo || '—';
  document.getElementById('detalheAutores').textContent = livro.autores || '—';
  document.getElementById('detalheCategoriaLinha').textContent = livro.categoria_nome || '—';
  document.getElementById('detalheISBN').textContent = livro.isbn || '—';
  document.getElementById('detalheAno').textContent = livro.ano_publicacao || '—';
  document.getElementById('detalheEditora').textContent = livro.editora_nome || '—';
  document.getElementById('detalheCategoria').textContent = livro.categoria_nome || '—';

  const exemplares = livro.exemplares || [];
  const est = livro.estatisticas || {};
  const baixados = exemplares.filter((e) => e.status === 'Baixado').length;
  document.getElementById('livroEstTotal').textContent = est.totalExemplares ?? 0;
  document.getElementById('livroEstDisponiveis').textContent = est.disponiveis ?? 0;
  document.getElementById('livroEstReservas').textContent = est.reservasAtivas ?? 0;
  const elBaixados = document.getElementById('livroEstBaixados');
  if (elBaixados) elBaixados.textContent = baixados;
  document.getElementById('detalheDisponibilidadeBadge').innerHTML = disponibilidadeStatusHTML(
    est.disponiveis ?? 0,
    est.totalExemplares ?? 0,
  );

  renderExemplaresCards(exemplares, document.getElementById('livroDetalheExemplares'), livro.eventos || []);

  const reservas = livro.reservas || [];
  const reservasTituloEl = document.getElementById('livroDetalheReservasTitulo');
  if (reservasTituloEl) reservasTituloEl.textContent = reservas.length ? `Reservas (${reservas.length})` : 'Reservas';
  const reservasEl = document.getElementById('livroDetalheReservas');
  if (reservasEl) {
    // Data da reserva (19/07/2026, quinta rodada de feedback): "assim o
    // bibliotecário entende há quanto tempo a pessoa está esperando" — vem
    // pronta do backend (reservas ativas já trazem data_reserva).
    reservasEl.innerHTML = reservas.length
      ? reservas
          .map(
            (r) => `<div class="livro-reserva-item">
                <span class="livro-reserva-nome">${sanitize(r.usuario_nome || '—')}</span>
                <span class="livro-reserva-fila">${r.fila}ª posição</span>
                <span class="livro-reserva-data">desde ${fmtData(r.data_reserva)}</span>
            </div>`,
          )
          .join('')
      : '<p class="livro-lista-vazia">Nenhuma reserva ativa para este livro.</p>';
  }

  const eventos = livro.eventos || [];
  // "Devoluções no prazo" e "Reservas ativas" saíram do bloco de métricas em
  // 16/07/2026 — o segundo já aparece em livroEstReservas (chip "Reservas"),
  // e o primeiro não era um sinal acionável (o mockup do feedback só lista
  // a contagem de atraso, que é o que pede atenção).
  const circ = computarCirculacao(eventos);
  const elUltimaMov = document.getElementById('livroUltimaMovimentacao');
  if (elUltimaMov) {
    elUltimaMov.textContent = circ.ultimaMovimentacao
      ? `${tituloEvento(circ.ultimaMovimentacao)} — ${fmtData(String(circ.ultimaMovimentacao.quando).split('T')[0])}`
      : 'Nenhuma registrada';
  }
  const elCircEmp = document.getElementById('livroCircEmprestimos');
  if (elCircEmp) elCircEmp.textContent = circ.totalEmprestimos;
  const elCircAtraso = document.getElementById('livroCircAtrasadas');
  if (elCircAtraso) elCircAtraso.textContent = circ.devolucoesAtrasadas;
  const elUltimoEmp = document.getElementById('livroUltimoEmprestimo');
  if (elUltimoEmp) {
    elUltimoEmp.textContent = circ.ultimoEmprestimo
      ? fmtData(String(circ.ultimoEmprestimo.quando).split('T')[0])
      : 'Nenhum registrado';
  }
  const elUltimaDev = document.getElementById('livroUltimaDevolucao');
  if (elUltimaDev) {
    elUltimaDev.textContent = circ.ultimaDevolucao
      ? fmtData(String(circ.ultimaDevolucao.quando).split('T')[0])
      : 'Nenhuma registrada';
  }
  const elUltimaRes = document.getElementById('livroUltimaReserva');
  if (elUltimaRes) {
    elUltimaRes.textContent = circ.ultimaReserva
      ? fmtData(String(circ.ultimaReserva.quando).split('T')[0])
      : 'Nenhuma registrada';
  }

  renderLivroTimeline(eventos);

  const escreve = podeEscrever();
  const btnEdit = document.getElementById('btnEditarDetalhe');
  if (btnEdit) btnEdit.style.display = escreve ? '' : 'none';
  const btnGerenciar = document.getElementById('btnGerenciarExemplaresDetalheLivro');
  if (btnGerenciar) btnGerenciar.style.display = escreve ? '' : 'none';
  const btnNovaReserva = document.getElementById('btnNovaReservaDetalheLivro');
  if (btnNovaReserva) btnNovaReserva.style.display = escreve ? '' : 'none';
  const btnNovoEmp = document.getElementById('btnNovoEmprestimoDetalheLivro');
  if (btnNovoEmp) btnNovoEmp.style.display = escreve ? '' : 'none';

  abrirModal('modalDetalhesLivro');
}

/* --- Detalhe do Exemplar (16/07/2026, reforma da tela de Exemplares) ---
 * Antes (drill-down a partir do Livro) reaproveitava o cache de
 * livroDetalhe sem chamar o backend. Unificado agora: sempre chama
 * exemplarDetalhe, tanto a partir da tela de Exemplares quanto do card do
 * Livro — histórico mais completo (inclui mudanças de status/baixa, que
 * livroDetalhe não tinha) e um único caminho de código para manter.
 * `origemLivro` controla o botão "Voltar ao Livro" e para onde a tela
 * volta depois de excluir/alterar status. */
let _detalheExemplarId = null;
let _detalheExemplarCodigo = null;
let _detalheExemplarStatusAtual = null;
let _detalheExemplarOrigemLivro = false;

async function abrirDetalheExemplar(exemplarId, origemLivro = false) {
  document.querySelectorAll('.action-menu.open').forEach((m) => m.classList.remove('open'));
  const { data: ex, error } = await ExemplarRepo.detalhe(exemplarId);
  if (error || !ex) {
    showAlert(origemLivro ? 'livroAlert' : 'exemplarAlert', 'Erro ao carregar detalhes do exemplar.', 'error');
    return;
  }
  _detalheExemplarId = ex.exemplar_id;
  _detalheExemplarCodigo = ex.codigo_patrimonial;
  _detalheExemplarStatusAtual = ex.status;
  _detalheExemplarOrigemLivro = origemLivro;

  document.getElementById('detalheExemplarCodigo').textContent = ex.codigo_patrimonial || '—';
  const livroEl = document.getElementById('detalheExemplarLivro');
  if (livroEl) {
    // Livro clicável (17/07/2026, feedback sobre a relação Livro↔Exemplar):
    // fecha este modal e abre o Detalhe do Livro — mesma navegação "Voltar
    // ao Livro" já usada quando o exemplar é aberto a partir de lá.
    // .detalhe-titulo-livro-link (não .btn-link genérico, que é pequeno/
    // pensado para links inline em tabelas) — mantém o peso visual de título
    // do cabeçalho mesmo sendo um botão clicável (feedback de 17/07/2026:
    // "o título do livro merece um peso maior" que o código do exemplar).
    livroEl.innerHTML = ex.livro_id
      ? `<button type="button" class="detalhe-titulo-livro-link" onclick="fecharModal('modalDetalheExemplar');abrirDetalhesLivro('${ex.livro_id}')">${sanitize(ex.livro_titulo || '—')}</button>`
      : sanitize(ex.livro_titulo || '—');
  }
  const sitDetalhe = situacaoExemplarBadge(ex);
  document.getElementById('detalheExemplarStatus').innerHTML =
    `<span class="badge badge-${sitDetalhe.classe}">${sanitize(sitDetalhe.texto)}</span>`;
  // Status também como texto no bloco "Situação do exemplar" (19/07/2026,
  // feedback de design) — o badge no cabeçalho é a identidade visual da
  // tela; esse campo deixa o bloco autocontido, legível sem precisar
  // olhar de volta para o topo do modal.
  const statusTextoEl = document.getElementById('detalheExemplarStatusTexto');
  if (statusTextoEl) statusTextoEl.textContent = sitDetalhe.texto;

  // Grid de Informações (17/07/2026): dados bibliográficos herdados do
  // Livro (ISBN/Categoria/Editora/Ano) + dados próprios da cópia física.
  document.getElementById('detalheExemplarIsbn').textContent = ex.livro_isbn || '—';
  document.getElementById('detalheExemplarCategoria').textContent = ex.livro_categoria || '—';
  document.getElementById('detalheExemplarEditora').textContent = ex.livro_editora || '—';
  document.getElementById('detalheExemplarAno').textContent = ex.livro_ano || '—';
  document.getElementById('detalheExemplarCadastro').textContent = ex.created_at
    ? fmtData(String(ex.created_at).split('T')[0])
    : '—';
  document.getElementById('detalheExemplarTotalEmprestimos').textContent = ex.totalEmprestimos || 0;

  // "Último empréstimo" e "Responsável pela baixa" não vêm prontos do
  // backend — derivados aqui da timeline (eventos já chega ordenada do
  // mais recente para o mais antigo), evitando mais uma consulta no servidor.
  const eventos = ex.eventos || [];
  const ultimoEmprestimoEv = eventos.find((ev) => ev.tipo === 'emprestimo');
  // "Último uso" clicável (19/07/2026, sexta rodada de feedback): a data vem
  // da timeline (acima), mas o ID pra navegar até o Detalhe do Empréstimo
  // vem de ultimo_emprestimo_id (exemplarDetalhe, backend) — os eventos da
  // timeline não carregam emprestimo_id. Sem histórico, fica só texto.
  const ultimoUsoEl = document.getElementById('detalheExemplarUltimoEmprestimo');
  if (ultimoUsoEl) {
    const dataTxt = ultimoEmprestimoEv ? fmtData(String(ultimoEmprestimoEv.quando).split('T')[0]) : 'Nunca emprestado';
    ultimoUsoEl.innerHTML = ex.ultimo_emprestimo_id
      ? `<button type="button" class="btn-link detalhe-valor" onclick="fecharModal('modalDetalheExemplar');abrirDetalhesEmprestimo('${ex.ultimo_emprestimo_id}')">${sanitize(dataTxt)}</button>`
      : sanitize(dataTxt);
  }

  const motivoWrap = document.getElementById('detalheExemplarMotivoWrap');
  const dataBaixaWrap = document.getElementById('detalheExemplarDataBaixaWrap');
  const respBaixaWrap = document.getElementById('detalheExemplarResponsavelBaixaWrap');
  if (ex.status === 'Baixado' && ex.motivo_baixa) {
    motivoWrap.style.display = '';
    document.getElementById('detalheExemplarMotivo').textContent = sanitize(ex.motivo_baixa);
    // Data da baixa (19/07/2026, feedback de design): updated_at funciona
    // como "última alteração de status" — único UPDATE que a aplicação faz
    // em `exemplar` (ver comentário em exemplarDetalhe, no backend).
    if (dataBaixaWrap) {
      if (ex.updated_at) {
        dataBaixaWrap.style.display = '';
        document.getElementById('detalheExemplarDataBaixa').textContent = fmtData(String(ex.updated_at).split('T')[0]);
      } else {
        dataBaixaWrap.style.display = 'none';
      }
    }
    const ultimaBaixaEv = eventos.find((ev) => ev.tipo === 'status_alterado' && ev.para === 'Baixado');
    if (ultimaBaixaEv?.responsavel) {
      respBaixaWrap.style.display = '';
      document.getElementById('detalheExemplarResponsavelBaixa').textContent = String(ultimaBaixaEv.responsavel).split(
        '@',
      )[0];
    } else {
      respBaixaWrap.style.display = 'none';
    }
  } else {
    motivoWrap.style.display = 'none';
    if (dataBaixaWrap) dataBaixaWrap.style.display = 'none';
    respBaixaWrap.style.display = 'none';
  }

  // "Empréstimo atual" só aparece quando o exemplar está emprestado.
  // 18/07/2026, feedback de design: Retirada e Prazo agora são campos
  // sempre visíveis (não competem mais por um único rótulo), e Atraso
  // aparece como um campo a mais — não substituindo Prazo — quando o
  // empréstimo está vencido. Isso concentra no modal tudo que a lista
  // principal de Exemplares deixou de mostrar inline (ver Achado 33).
  const atualBloco = document.getElementById('detalheExemplarAtualBloco');
  if (ex.status === 'Emprestado') {
    atualBloco.style.display = '';
    document.getElementById('detalheExemplarLeitorAtual').textContent = ex.usuario_nome || '—';
    document.getElementById('detalheExemplarRetiradaAtual').textContent = ex.data_retirada
      ? fmtData(ex.data_retirada)
      : '—';
    document.getElementById('detalheExemplarPrevisaoAtual').textContent = ex.data_prevista
      ? fmtData(ex.data_prevista)
      : '—';
    const atrasoWrap = document.getElementById('detalheExemplarAtrasoWrap');
    if (ex.atrasado && ex.dias_atraso) {
      if (atrasoWrap) atrasoWrap.style.display = '';
      document.getElementById('detalheExemplarAtrasoAtual').textContent =
        `${ex.dias_atraso} dia${ex.dias_atraso === 1 ? '' : 's'}`;
    } else if (atrasoWrap) {
      atrasoWrap.style.display = 'none';
    }
    // "Ver empréstimo" (19/07/2026, sexta rodada de feedback): navega até o
    // Detalhe do Empréstimo em andamento (emprestimo_atual_id).
    const btnVerEmp = document.getElementById('detalheExemplarVerEmprestimo');
    if (btnVerEmp) {
      btnVerEmp.style.display = ex.emprestimo_atual_id ? '' : 'none';
      btnVerEmp.onclick = () => {
        fecharModal('modalDetalheExemplar');
        abrirDetalhesEmprestimo(ex.emprestimo_atual_id);
      };
    }
  } else {
    atualBloco.style.display = 'none';
  }

  const reservas = ex.reservasAtivasLivro || [];
  const reservasBloco = document.getElementById('detalheExemplarReservasBloco');
  if (reservasBloco) reservasBloco.style.display = reservas.length ? '' : 'none';
  const reservasTituloEl = document.getElementById('detalheExemplarReservasTitulo');
  if (reservasTituloEl) reservasTituloEl.textContent = `Reservas deste livro (${reservas.length})`;
  const reservasEl = document.getElementById('detalheExemplarReservas');
  if (reservasEl) {
    reservasEl.innerHTML = reservas
      .map(
        (r, idx) => `<div class="livro-exemplar-item">
            <span class="livro-exemplar-codigo">${sanitize(r.usuario_nome || '—')}</span>
            <span class="livro-exemplar-info">${idx + 1}ª posição · desde ${fmtData(r.data_reserva)}</span>
        </div>`,
      )
      .join('');
  }

  renderLeitorTimeline(ex.eventos || [], 'detalheExemplarTimeline', 'Este exemplar ainda não possui movimentações.', {
    contexto: 'livro',
    expandidoPorPadrao: true,
  });

  const escreve = podeEscrever();
  const btnAlterar = document.getElementById('btnAlterarStatusDetalheExemplar');
  if (btnAlterar) btnAlterar.style.display = escreve && ex.status !== 'Emprestado' ? '' : 'none';
  // Excluir (17/07/2026): fica visível mas desabilitado — com o mesmo motivo
  // explicado no modalExemplarNaoExcluivel que abriria se fosse clicável —
  // sempre que o exemplar está emprestado ou já teve algum empréstimo no
  // histórico. Só exemplares "nunca usados" podem ser excluídos de verdade.
  const btnExcluir = document.getElementById('btnExcluirDetalheExemplar');
  if (btnExcluir) {
    btnExcluir.style.display = escreve ? '' : 'none';
    const bloqueado = ex.status === 'Emprestado' || (ex.totalEmprestimos || 0) > 0;
    btnExcluir.disabled = bloqueado;
    btnExcluir.title = bloqueado
      ? ex.status === 'Emprestado'
        ? 'Registre a devolução antes de excluir.'
        : 'Exemplar com histórico de circulação — utilize o status Baixado.'
      : '';
  }
  const btnVoltar = document.getElementById('btnVoltarAoLivroExemplar');
  if (btnVoltar) btnVoltar.style.display = origemLivro ? '' : 'none';

  if (origemLivro) fecharModal('modalDetalhesLivro');
  abrirModal('modalDetalheExemplar');
}
function voltarAoLivroDoExemplar() {
  fecharModal('modalDetalheExemplar');
  if (_livroDetalheId) abrirDetalhesLivro(_livroDetalheId);
}
function alterarStatusExemplarDetalhe() {
  if (!_detalheExemplarId) return;
  abrirAlterarStatusExemplar(_detalheExemplarId, _detalheExemplarCodigo, _detalheExemplarStatusAtual, async () => {
    if (_detalheExemplarOrigemLivro) await abrirDetalheExemplar(_detalheExemplarId, true);
    else {
      pageState.exemplares = pageState.exemplares || 1;
      await renderExemplares();
      await abrirDetalheExemplar(_detalheExemplarId, false);
    }
  });
}
function excluirExemplarDetalhe() {
  if (!_detalheExemplarId) return;
  deleteExemplar(_detalheExemplarId, _detalheExemplarOrigemLivro);
}

/* --- Alterar Status do Exemplar (16/07/2026) — modal compartilhado entre a
 * tela de Exemplares, o Detalhe do Exemplar e o Gerenciar Exemplares (a
 * partir do Livro). Nunca oferece "Emprestado" (só surge via empréstimo) e
 * exige motivo quando o novo status é Baixado — mesma regra do backend. */
let _alterarStatusExemplarId = null;
let _alterarStatusExemplarAposSalvar = null;
function abrirAlterarStatusExemplar(id, codigo, statusAtual, aposSalvar) {
  document.querySelectorAll('.action-menu.open').forEach((m) => m.classList.remove('open'));
  _alterarStatusExemplarId = id;
  _alterarStatusExemplarAposSalvar = aposSalvar || null;
  const codigoEl = document.getElementById('alterarStatusExemplarCodigo');
  if (codigoEl) codigoEl.textContent = codigo ? `Exemplar ${codigo}` : '';
  const sel = document.getElementById('alterarStatusExemplarNovo');
  if (sel) sel.value = ['Disponivel', 'Manutencao', 'Baixado'].includes(statusAtual) ? statusAtual : 'Disponivel';
  toggleAlterarStatusExemplarMotivo();
  const motivoSel = document.getElementById('alterarStatusExemplarMotivo');
  if (motivoSel) motivoSel.value = '';
  const a = document.getElementById('alterarStatusExemplarAlert');
  if (a) a.innerHTML = '';
  abrirModal('modalAlterarStatusExemplar');
}
function toggleAlterarStatusExemplarMotivo() {
  const status = raw('alterarStatusExemplarNovo');
  const wrap = document.getElementById('alterarStatusExemplarMotivoWrap');
  if (wrap) wrap.style.display = status === 'Baixado' ? '' : 'none';
}
async function salvarAlterarStatusExemplar() {
  if (!_alterarStatusExemplarId || pendingOp) return;
  const status = raw('alterarStatusExemplarNovo');
  const motivo = status === 'Baixado' ? raw('alterarStatusExemplarMotivo') : null;
  if (status === 'Baixado' && !motivo) {
    showAlert('alterarStatusExemplarAlert', 'Informe o motivo da baixa.', 'error');
    return;
  }
  pendingOp = true;
  const btn = document.getElementById('btnSalvarAlterarStatusExemplar');
  if (btn) btn.disabled = true;
  const res = await ExemplarService.atualizarStatus(_alterarStatusExemplarId, status, motivo);
  if (btn) btn.disabled = false;
  pendingOp = false;
  showAlert('alterarStatusExemplarAlert', res.message, res.ok ? 'success' : 'error');
  if (!res.ok) return;
  fecharModal('modalAlterarStatusExemplar');
  await reloadExemplarSelects();
  if (_alterarStatusExemplarAposSalvar) await _alterarStatusExemplarAposSalvar();
}

/* --- Excluir Exemplar (16/07/2026; bloqueio preventivo em 17/07/2026) —
 * bloqueado no backend se o exemplar estiver emprestado ou tiver histórico
 * de empréstimos (nesses casos a recomendação é marcar como Baixado).
 * `origemLivro` decide se a tela volta para Gerenciar Exemplares/Livros ou
 * para a tela de Exemplares.
 *
 * Feedback de 17/07/2026: em vez de deixar o bibliotecário clicar em
 * "Excluir permanentemente" só para descobrir depois que não era permitido,
 * checamos aqui (via exemplarDetalhe) se o exemplar está emprestado ou tem
 * histórico, e mostramos um aviso bloqueante (modalExemplarNaoExcluivel) em
 * vez do confirm genérico nesses casos. Custa uma consulta extra por clique
 * em "Excluir" — aceitável na escala de uma biblioteca. */
let _pendingDeleteExemplarId = null;
let _pendingDeleteExemplarOrigemLivro = false;
async function deleteExemplar(id, origemLivro = false) {
  document.querySelectorAll('.action-menu.open').forEach((m) => m.classList.remove('open'));
  const { data: ex } = await ExemplarRepo.detalhe(id);
  const bloqueado = ex && (ex.status === 'Emprestado' || (ex.totalEmprestimos || 0) > 0);
  if (bloqueado) {
    const msgEl = document.getElementById('exemplarNaoExcluivelMsg');
    if (msgEl) {
      msgEl.innerHTML =
        ex.status === 'Emprestado'
          ? 'Este exemplar está emprestado no momento. Registre a devolução antes de excluir.'
          : 'Este exemplar possui histórico de circulação. Utilize o status <strong>Baixado</strong> em vez de excluir.';
    }
    abrirModal('modalExemplarNaoExcluivel');
    return;
  }
  _pendingDeleteExemplarId = id;
  _pendingDeleteExemplarOrigemLivro = origemLivro;
  abrirModal('modalConfirmarExclusaoExemplar');
}
async function _confirmarDeleteExemplar() {
  if (!_pendingDeleteExemplarId || pendingOp) return;
  const id = _pendingDeleteExemplarId;
  const origemLivro = _pendingDeleteExemplarOrigemLivro;
  _pendingDeleteExemplarId = null;
  pendingOp = true;
  const res = await ExemplarService.excluir(id);
  pendingOp = false;
  fecharModal('modalConfirmarExclusaoExemplar');
  fecharModal('modalDetalheExemplar');
  showAlert(origemLivro ? 'gerenciarExemplaresAlert' : 'exemplarAlert', res.message, res.ok ? 'success' : 'error');
  if (!res.ok) return;
  await reloadExemplarSelects();
  if (origemLivro) {
    await carregarGerenciarExemplares();
    await renderLivros();
  } else {
    pageState.exemplares = 1;
    await renderExemplares();
  }
}

/* --- Gerenciar Exemplares (escopado por livro, a partir de Livros) ---
 * Item da especificação de 14/07/2026: em vez de mandar o bibliotecário para
 * a tela geral de Exemplares, o kebab/detalhes do livro abrem um modal já
 * filtrado a este livro, com "Adicionar Exemplar" sem precisar escolher o
 * livro de novo. Reaproveita livroDetalhe (mesmo payload do painel de
 * detalhes) em vez de criar mais um endpoint só para essa lista. Revisado em
 * 16/07/2026: código patrimonial não é mais digitado (gerado
 * automaticamente) e o status inicial segue a mesma restrição do resto do
 * app (Disponível/Manutenção/Baixado, com motivo quando Baixado). */
let _gerenciarExemplaresLivroId = null;
async function carregarGerenciarExemplares() {
  const listaEl = document.getElementById('gerenciarExemplaresLista');
  if (listaEl) listaEl.innerHTML = '<p class="loading">Carregando...</p>';
  const { data: livro, error } = await LivroRepo.detalhe(_gerenciarExemplaresLivroId);
  if (error || !livro) {
    if (listaEl) listaEl.innerHTML = '';
    showAlert('gerenciarExemplaresAlert', 'Erro ao carregar exemplares.', 'error');
    return;
  }
  const tituloEl = document.getElementById('gerenciarExemplaresLivroTitulo');
  if (tituloEl) tituloEl.textContent = livro.titulo || '';
  const autorEl = document.getElementById('gerenciarExemplaresLivroAutor');
  if (autorEl) autorEl.textContent = livro.autores || '';

  // Resumo do livro (19/07/2026, oitava rodada de feedback — "assim o
  // bibliotecário entende rapidamente a situação do livro antes de tomar
  // qualquer ação"): total sempre aparece, Disponíveis sempre aparece (é a
  // pergunta que importa — "dá pra emprestar agora?"); Emprestados/Em
  // manutenção/Baixados só aparecem quando existem, pra não poluir o resumo
  // de um livro só com exemplares disponíveis com "0 emprestados".
  const exemplares = livro.exemplares || [];
  const statsEl = document.getElementById('gerenciarExemplaresStats');
  if (statsEl) {
    const porStatus = (s) => exemplares.filter((e) => e.status === s).length;
    const chip = (valor, label) =>
      `<div class="leitor-resumo-chip"><span class="leitor-resumo-valor">${valor}</span><span class="leitor-resumo-label">${label}</span></div>`;
    const chips = [chip(exemplares.length, exemplares.length === 1 ? 'Exemplar' : 'Exemplares')];
    chips.push(chip(porStatus('Disponivel'), 'Disponíveis'));
    if (porStatus('Emprestado')) chips.push(chip(porStatus('Emprestado'), 'Emprestados'));
    if (porStatus('Manutencao')) chips.push(chip(porStatus('Manutencao'), 'Em manutenção'));
    if (porStatus('Baixado')) chips.push(chip(porStatus('Baixado'), 'Baixados'));
    statsEl.innerHTML = chips.join('');
  }

  // Aviso de reservas ativas (19/07/2026): "hoje fica solto — eu colocaria
  // um pequeno aviso" — só aparece quando há reservas, evitando repetir o
  // número em mais um lugar quando não há fila nenhuma.
  const reservas = livro.reservas || [];
  const avisoEl = document.getElementById('gerenciarExemplaresReservasAviso');
  if (avisoEl) {
    if (reservas.length) {
      avisoEl.style.display = '';
      avisoEl.textContent = `Este livro possui ${reservas.length} reserva${reservas.length === 1 ? '' : 's'} ativa${reservas.length === 1 ? '' : 's'}.`;
    } else {
      avisoEl.style.display = 'none';
    }
  }

  renderExemplaresGerenciarCards(exemplares, listaEl);
}
async function abrirGerenciarExemplares(livroId) {
  document.querySelectorAll('.action-menu.open').forEach((m) => m.classList.remove('open'));
  _gerenciarExemplaresLivroId = livroId;
  const alertEl = document.getElementById('gerenciarExemplaresAlert');
  if (alertEl) alertEl.innerHTML = '';
  const statusSel = document.getElementById('gerenciarExemplarStatus');
  if (statusSel) statusSel.value = 'Disponivel';
  toggleGerenciarExemplarMotivo();
  abrirModal('modalGerenciarExemplares');
  await carregarGerenciarExemplares();
}
function abrirAlterarStatusExemplarGerenciar(id, codigo, statusAtual) {
  abrirAlterarStatusExemplar(id, codigo, statusAtual, async () => {
    await carregarGerenciarExemplares();
    await renderLivros();
  });
}
function toggleGerenciarExemplarMotivo() {
  const status = raw('gerenciarExemplarStatus');
  const wrap = document.getElementById('gerenciarExemplarMotivoWrap');
  if (wrap) wrap.style.display = status === 'Baixado' ? '' : 'none';
}
async function adicionarExemplarAoLivro() {
  if (pendingOp || !_gerenciarExemplaresLivroId) return;
  const status = raw('gerenciarExemplarStatus') || 'Disponivel';
  const motivo = status === 'Baixado' ? raw('gerenciarExemplarMotivo') : null;
  if (status === 'Baixado' && !motivo) {
    showAlert('gerenciarExemplaresAlert', 'Informe o motivo da baixa.', 'error');
    return;
  }
  pendingOp = true;
  const btn = document.getElementById('btnAdicionarExemplar');
  btn.disabled = true;
  const res = await ExemplarService.criar({ livro_id: _gerenciarExemplaresLivroId, status, motivo });
  btn.disabled = false;
  pendingOp = false;
  showAlert('gerenciarExemplaresAlert', res.message, res.ok ? 'success' : 'error');
  if (!res.ok) return;
  const statusSel = document.getElementById('gerenciarExemplarStatus');
  if (statusSel) statusSel.value = 'Disponivel';
  toggleGerenciarExemplarMotivo();
  await reloadExemplarSelects();
  await carregarGerenciarExemplares();
  await renderLivros();
}

/* --- "Novo Empréstimo" a partir do painel de Detalhes do Livro ---
 * Mesmo espírito do atalho equivalente na Central do Leitor (Achado 22):
 * abre o modal já com o Livro definido, dispensando reescolhê-lo, e move o
 * foco para o campo que ainda falta (Leitor). */
async function novoEmprestimoDoLivro() {
  const livroId = _livroDetalheId;
  if (!livroId) return;
  fecharModal('modalDetalhesLivro');
  await showSection('emprestimos', document.getElementById('nav-emprestimos'));
  abrirModalNovoEmprestimo();
  const selLivro = document.getElementById('emprestimoLivro');
  if (selLivro) selLivro.value = livroId;
  await aoEscolherLivroEmprestimo();
  setTimeout(() => document.getElementById('emprestimoUsuario')?.focus(), 100);
}
/* --- "Nova Reserva" a partir do painel de Detalhes do Livro (19/07/2026,
 * quinta rodada de feedback) --- mesmo espírito de novoEmprestimoDoLivro,
 * mas a tela de Reservas ainda usa formulário inline (não modal — ver "O
 * que ainda falta" na auditoria), então aqui basta navegar até a seção e
 * pré-selecionar o Livro, sem abrir modal nenhum. */
async function novaReservaDoLivro() {
  const livroId = _livroDetalheId;
  if (!livroId) return;
  fecharModal('modalDetalhesLivro');
  await showSection('reservas', document.getElementById('nav-reservas'));
  const selLivro = document.getElementById('reservaLivro');
  if (selLivro) selLivro.value = livroId;
  await aoEscolherLivroReserva();
  setTimeout(() => document.getElementById('reservaUsuario')?.focus(), 100);
}

function deleteLivro(id) {
  _pendingDeleteId = id;
  abrirModal('modalConfirmarExclusao');
}

async function _confirmarDelete() {
  if (!_pendingDeleteId || pendingOp) return;
  const id = _pendingDeleteId;
  _pendingDeleteId = null;
  pendingOp = true;
  const res = await LivroService.excluir(id);
  pendingOp = false;
  fecharModal('modalConfirmarExclusao');
  showAlert('livroAlert', res.message, res.ok ? 'success' : 'error');
  if (res.ok) {
    pageState.livros = 1;
    await reloadLivroSelects();
    await renderLivros();
  }
}

/* ---------- Exemplares ----------
 * Reforma de 16/07/2026 (feedback de design): formulário inline virou modal
 * (mesmo padrão de Livros); UUID sai da interface — código patrimonial é o
 * identificador visual, gerado automaticamente pelo banco; badge de status
 * colorida (com o novo status Manutenção) + menu de ações no lugar do select
 * inline; filtros de status/livro; linha clicável abre o Detalhe do Exemplar. */
async function renderExemplares() {
  const term = searchTerm('exemplaresSearch');
  const status = document.getElementById('exemplarFiltroStatus')?.value || '';
  const livro_id = document.getElementById('exemplarFiltroLivro')?.value || '';
  // Filtro "Leitor" (17/07/2026, feedback de design) — "quais livros a Carla
  // está com". Só lista leitores com empréstimo em aberto agora (ver
  // reloadExemplarSelects), não todos os leitores ativos.
  const usuario_id = document.getElementById('exemplarFiltroLeitor')?.value || '';
  const CM = "document.querySelectorAll('.action-menu.open').forEach(m=>m.classList.remove('open'))";
  await renderPaginado({
    tbodyId: 'exemplaresTable',
    paginationId: 'exemplaresPagination',
    colspan: 5,
    section: 'exemplares',
    fetch: () =>
      ExemplarRepo.pagina({ page: pageState.exemplares, pageSize: PAGE_SIZE, q: term, status, livro_id, usuario_id }),
    // Contagem com substantivo próprio (17/07/2026, feedback de design: "12
    // registro(s)" não dizia o quê) — mesmo padrão de renderUsuarios, que já
    // sobrescreve o texto padrão de updateHint por um mais específico.
    onCount: (count) => {
      const hintEl = document.getElementById('exemplaresHint');
      const n = Number(count) || 0;
      if (hintEl) hintEl.textContent = term ? `${n} resultado(s) para "${term}"` : `${n} exemplar(es) cadastrado(s)`;
    },
    emptyMsg: 'Nenhum exemplar encontrado.',
    rowFn: (e) => {
      const sit = situacaoExemplarBadge(e);
      const badge = `<span class="badge badge-${sit.classe}">${sanitize(sit.texto)}</span>`;
      // 19/07/2026, feedback de design: a coluna Situação (badge, só estado
      // físico) e a coluna Detalhe (texto contextual — leitor/atraso/motivo/
      // data da baixa) foram separadas de novo, mas dessa vez como DUAS
      // colunas em vez de reempilhar tudo numa célula só (o problema
      // original do Achado 33 não era mostrar contexto, era misturar dois
      // conceitos — estado do exemplar vs. situação do empréstimo — na
      // mesma célula). Ver detalheExemplarColuna.
      const detalheTxt = detalheExemplarColuna(e);
      // Menu de ações (17/07/2026): "Ver detalhes" no topo (a linha já é
      // clicável e abre o mesmo destino — item extra por explicitação/
      // acessibilidade), separado por divisor das ações administrativas.
      const itensMenu =
        e.status !== 'Emprestado'
          ? `<button role="menuitem" onclick="${CM};abrirDetalheExemplar('${e.exemplar_id}')">Ver detalhes</button>
             <div class="action-menu-divider"></div>
             <button role="menuitem" onclick="${CM};abrirAlterarStatusExemplarLinha('${e.exemplar_id}', '${sanitize(e.codigo_patrimonial)}', '${e.status}')">Alterar status</button>
             <div class="action-menu-divider"></div>
             <button role="menuitem" class="action-menu-item--danger" onclick="${CM};deleteExemplar('${e.exemplar_id}')">Excluir</button>`
          : `<button role="menuitem" onclick="${CM};abrirDetalheExemplar('${e.exemplar_id}')">Ver detalhes</button>
             <div class="action-menu-divider"></div>
             <button role="menuitem" disabled title="Registre a devolução antes de alterar o status ou excluir">Excluir</button>`;
      const acoes = podeEscrever()
        ? `<div class="action-menu-wrap">
                <button class="btn-icon" onclick="toggleActionMenu(this)" title="Ações" aria-haspopup="true" aria-label="Ações">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                </button>
                <div class="action-menu" role="menu">${itensMenu}</div>
               </div>`
        : '&#8212;';
      // Livro clicável (17/07/2026): abre o Detalhe do Livro sem precisar
      // passar pela tela de Livros. stopPropagation evita disparar também o
      // clique na linha (que abriria o Detalhe do Exemplar).
      const livroCel = e.livro_id
        ? `<button type="button" class="btn-link" onclick="event.stopPropagation();${CM};abrirDetalhesLivro('${e.livro_id}')">${destacarTrecho(e.titulo, term) || 'N/A'}</button>`
        : destacarTrecho(e.titulo, term) || 'N/A';
      return `<tr class="livro-row" data-id="${e.exemplar_id}" onclick="abrirDetalheExemplar(this.dataset.id)">
            <td data-label="Código"><span class="exemplar-codigo-destaque codigo-patrimonial">${destacarTrecho(e.codigo_patrimonial, term)}</span></td>
            <td data-label="Livro">${livroCel}</td>
            <td data-label="Situação">${badge}</td>
            <td data-label="Detalhe">${detalheTxt ? `<span class="dias-info">${detalheTxt}</span>` : '—'}</td>
            <td class="td-actions" onclick="event.stopPropagation()">${acoes}</td>
        </tr>`;
    },
  });
}
function abrirAlterarStatusExemplarLinha(id, codigo, statusAtual) {
  abrirAlterarStatusExemplar(id, codigo, statusAtual, async () => {
    await renderExemplares();
  });
}
function toggleExemplarMotivoBaixa() {
  const status = raw('exemplarStatus');
  const wrap = document.getElementById('exemplarMotivoBaixaWrap');
  if (wrap) wrap.style.display = status === 'Baixado' ? '' : 'none';
}
async function abrirModalNovoExemplar() {
  const livroSel = document.getElementById('exemplarLivro');
  if (livroSel) livroSel.value = '';
  const statusSel = document.getElementById('exemplarStatus');
  if (statusSel) statusSel.value = 'Disponivel';
  toggleExemplarMotivoBaixa();
  const motivoSel = document.getElementById('exemplarMotivoBaixa');
  if (motivoSel) motivoSel.value = '';
  const a = document.getElementById('exemplarModalAlert');
  if (a) a.innerHTML = '';
  // Preview do próximo código patrimonial (17/07/2026, feedback de design) —
  // é só uma prévia (a sequence só avança de verdade no cadastro), por isso
  // o texto não promete o código, mostra "previsto".
  const previewEl = document.getElementById('exemplarCodigoPreview');
  if (previewEl) previewEl.textContent = 'Calculando o próximo código...';
  abrirModal('modalNovoExemplar');
  const { data: proximo } = await ExemplarRepo.proximoCodigo();
  if (previewEl)
    previewEl.textContent = proximo ? `Código previsto: ${proximo}` : 'Gerado automaticamente ao cadastrar.';
}
async function createExemplar() {
  if (pendingOp) return;
  const livro_id = raw('exemplarLivro');
  const status = raw('exemplarStatus');
  const motivo = status === 'Baixado' ? raw('exemplarMotivoBaixa') : null;
  if (!livro_id) {
    showAlert('exemplarModalAlert', 'Selecione o livro.', 'error');
    return;
  }
  if (status === 'Baixado' && !motivo) {
    showAlert('exemplarModalAlert', 'Informe o motivo da baixa.', 'error');
    return;
  }
  pendingOp = true;
  const btn = document.getElementById('btnCadExemplar');
  btn.disabled = true;
  const res = await ExemplarService.criar({ livro_id, status, motivo });
  btn.disabled = false;
  pendingOp = false;
  showAlert('exemplarModalAlert', res.message, res.ok ? 'success' : 'error');
  if (!res.ok) return;
  fecharModal('modalNovoExemplar');
  showAlert('exemplarAlert', res.message, 'success');
  pageState.exemplares = 1;
  await reloadExemplarSelects();
  await renderExemplares();
}

/* ---------- Empréstimos ----------
 * Redesenho de 14/07/2026: formulário inline virou modal (como Livros),
 * cascata Leitor→Livro→Exemplar, badges de situação com dias restantes/de
 * atraso, devolução com preview de multa, e painel de detalhes com timeline
 * (mesmos padrões visuais da Central do Leitor). */
// Sem emojis (🔴🟡🟢⚪) desde 16/07/2026 — feedback de design pediu badges
// só com as cores da identidade, sem ícones tipo "aplicativo".
// Redesenho de 19/07/2026 ("destacar visualmente atrasos"): 3 estados fixos
// — Devolvido (verde), Atrasado (vermelho), Em andamento (azul). O "Vence
// hoje" que antes virava um 4º estado de badge saiu daqui — essa informação
// agora mora só na coluna Vencimento ao lado (ver vencimentoInfoEmprestimo),
// pra não duplicar o mesmo dado com dois pesos visuais diferentes na mesma
// linha.
function situacaoEmprestimoBadge(e) {
  if (e.situacao === 'Devolvido') return { texto: 'Devolvido', classe: 'success' };
  if (e.situacao === 'Atrasado') return { texto: 'Atrasado', classe: 'danger' };
  return { texto: 'Em andamento', classe: 'info' };
}
// Coluna Detalhe (19/07/2026, feedback de design): a antiga coluna
// "Situação" misturava estado (badge) com detalhe operacional (dias) na
// mesma célula — passou a ser duas colunas. Renomeada de "Vencimento" para
// "Detalhe" na quarta rodada de feedback (mesmo dia) — pedido explícito do
// usuário, com um exemplo completo da tabela desejada; supersede o nome
// "Vencimento" da rodada anterior. Mesmo padrão de `detalheExemplarColuna`
// (Achado 37): um texto contextual por linha. Sem "(s)" técnico —
// plural/singular corretos — e "Vence amanhã" como caso próprio (antes
// virava só "Vence em 1 dia(s)").
function detalheEmprestimoColuna(e) {
  if (e.situacao === 'Devolvido') return e.data_devolucao ? `Devolvido em ${fmtData(e.data_devolucao)}` : '—';
  if (e.situacao === 'Atrasado') {
    const n = e.dias_atraso || 0;
    return `${n} dia${n === 1 ? '' : 's'} em atraso`;
  }
  if (e.dias_restantes === 0) return 'Vence hoje';
  if (e.dias_restantes === 1) return 'Vence amanhã';
  if (e.dias_restantes != null) return `Vence em ${e.dias_restantes} dias`;
  return '';
}
async function renderEmprestimos() {
  const term = searchTerm('emprestimosSearch');
  const status = document.getElementById('emprestimoFiltroStatus')?.value || '';
  const usuario_id = document.getElementById('emprestimoFiltroLeitor')?.value || '';
  const livro_id = document.getElementById('emprestimoFiltroLivro')?.value || '';
  const vencimento = document.getElementById('emprestimoFiltroVencimento')?.value || '';
  const CM = "document.querySelectorAll('.action-menu.open').forEach(m=>m.classList.remove('open'))";
  await renderPaginado({
    tbodyId: 'emprestimosTable',
    paginationId: 'emprestimosPagination',
    colspan: 7,
    section: 'emprestimos',
    fetch: () =>
      EmprestimoRepo.pagina({
        page: pageState.emprestimos,
        pageSize: PAGE_SIZE,
        q: term,
        status,
        usuario_id,
        livro_id,
        vencimento,
      }),
    onCount: (count) => updateHint('emprestimosHint', count, term),
    emptyTd: () =>
      `<div class="livros-empty-inner"><p>Nenhum empréstimo encontrado.</p><small>Os empréstimos registrados aparecerão aqui.</small></div>`,
    rowFn: (e) => {
      const sit = situacaoEmprestimoBadge(e);
      const detalheTxt = detalheEmprestimoColuna(e);
      // Menu de ações mantém só as 2 ações reais hoje disponíveis (Ver
      // detalhes / Devolver) — feedback de 19/07/2026 pediu Renovar/Aplicar
      // multa manual/Cancelar mesmo que "implementadas futuramente", mas
      // isso contraria o princípio já adotado no sistema (ver Achado 34,
      // "Marcar como atendida") de nunca sugerir na interface uma ação que o
      // backend não executa de verdade. Ver Achado 36 para a lista dessas
      // ações como candidatas documentadas de próxima rodada.
      const acoes = `<div class="action-menu-wrap">
                <button class="btn-icon" onclick="event.stopPropagation();toggleActionMenu(this)" title="Ações" aria-haspopup="true" aria-label="Ações">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                </button>
                <div class="action-menu" role="menu">
                    <button role="menuitem" onclick="event.stopPropagation();${CM};abrirDetalhesEmprestimo('${e.emprestimo_id}')">Ver detalhes</button>
                    ${
                      podeEscrever() && !e.data_devolucao
                        ? `<button role="menuitem" class="action-menu-item--success" onclick="event.stopPropagation();${CM};abrirModalDevolucao('${e.emprestimo_id}')">Devolver</button>`
                        : ''
                    }
                </div>
               </div>`;
      // Leitor/Livro/Exemplar clicáveis (19/07/2026, "melhoria que faria
      // bastante diferença"): navegam direto pro detalhe de cada entidade
      // sem precisar sair e buscar de novo — mesmo padrão .btn-link +
      // stopPropagation já usado na tabela de Exemplares (Livro clicável).
      // A linha inteira continua abrindo o Detalhe do Empréstimo.
      return `<tr class="clickable-row" data-id="${e.emprestimo_id}" onclick="abrirDetalhesEmprestimo(this.dataset.id)">
            <td data-label="Leitor">
                <button type="button" class="btn-link" onclick="event.stopPropagation();abrirDetalhesLeitor('${e.usuario_id}')">${destacarTrecho(e.usuario_nome, term)}</button>
            </td>
            <td data-label="Livro / Exemplar">
                <button type="button" class="btn-link emprestimo-livro-titulo" onclick="event.stopPropagation();abrirDetalhesLivro('${e.livro_id}')">${destacarTrecho(e.livro_titulo, term)}</button>
                <br><button type="button" class="btn-link emprestimo-exemplar-codigo" onclick="event.stopPropagation();abrirDetalheExemplar('${e.exemplar_id}')">${destacarTrecho(e.codigo_patrimonial, term)}</button>
            </td>
            <td data-label="Retirada">${fmtData(e.data_retirada)}</td>
            <td data-label="Prazo">${fmtData(e.data_prevista)}</td>
            <td data-label="Situação">
                <span class="badge badge-${sit.classe}">${sit.texto}</span>
            </td>
            <td data-label="Detalhe">${detalheTxt ? `<span class="dias-info">${detalheTxt}</span>` : '—'}</td>
            <td class="td-actions" onclick="event.stopPropagation()">${acoes}</td>
        </tr>`;
    },
  });
}

/* --- Modal "Novo Empréstimo" (cascata Leitor → Livro → Exemplar) --- */
function abrirModalNovoEmprestimo() {
  resetLeitorFixo('emprestimo');
  const selUsuario = document.getElementById('emprestimoUsuario');
  if (selUsuario) selUsuario.value = '';
  const selLivro = document.getElementById('emprestimoLivro');
  if (selLivro) selLivro.value = '';
  const selExemplar = document.getElementById('emprestimoExemplar');
  if (selExemplar) {
    selExemplar.innerHTML = '<option value="">Selecione um livro primeiro...</option>';
    selExemplar.disabled = true;
  }
  const resumo = document.getElementById('emprestimoResumoLivro');
  if (resumo) {
    resumo.style.display = 'none';
    resumo.innerHTML = '';
  }
  // Período padrão sugerido (14 dias) — default só de front-end para agilizar
  // o preenchimento; o bibliotecário pode alterar livremente antes de
  // confirmar. Não é uma regra de negócio gravada no servidor.
  const hoje = todayStr();
  const prevista = new Date();
  prevista.setDate(prevista.getDate() + 14);
  const elRetirada = document.getElementById('emprestimoDataRetirada');
  if (elRetirada) elRetirada.value = hoje;
  const elPrevista = document.getElementById('emprestimoDataPrevista');
  if (elPrevista) elPrevista.value = prevista.toISOString().split('T')[0];
  const a = document.getElementById('emprestimoModalAlert');
  if (a) a.innerHTML = '';
  abrirModal('modalNovoEmprestimo');
}
// Ao escolher o Livro no modal: filtra os exemplares disponíveis para esse
// livro (cascata, item 10 do pedido) e busca o resumo de disponibilidade
// (item 13: disponíveis/emprestados/reservas) para orientar o bibliotecário.
async function aoEscolherLivroEmprestimo() {
  const livroId = raw('emprestimoLivro');
  const resumo = document.getElementById('emprestimoResumoLivro');
  if (!livroId) {
    const selExemplar = document.getElementById('emprestimoExemplar');
    if (selExemplar) {
      selExemplar.innerHTML = '<option value="">Selecione um livro primeiro...</option>';
      selExemplar.disabled = true;
    }
    if (resumo) {
      resumo.style.display = 'none';
      resumo.innerHTML = '';
    }
    return;
  }
  popularExemplarPorLivro(livroId);
  if (!resumo) return;
  resumo.style.display = '';
  resumo.innerHTML = '<span class="emprestimo-resumo-carregando">Carregando disponibilidade...</span>';
  const { data, error } = await LivroDisponibilidadeRepo.resumo(livroId);
  if (error || !data) {
    resumo.style.display = 'none';
    resumo.innerHTML = '';
    return;
  }
  resumo.innerHTML = `
        <span class="emprestimo-resumo-item"><strong>${data.disponiveis}</strong> disponível(is)</span>
        <span class="emprestimo-resumo-item"><strong>${data.emprestados}</strong> emprestado(s)</span>
        <span class="emprestimo-resumo-item"><strong>${data.reservas}</strong> reserva(s) ativa(s)</span>
    `;
}
// Mesmo painel de disponibilidade do modal "Novo Empréstimo" (item 13 de
// 14/07/2026), reaproveitado no formulário de Nova Reserva (17/07/2026,
// feedback de design) — ver aoEscolherLivroEmprestimo() acima. Aqui não há
// cascata de exemplar (reserva não escolhe exemplar específico), só o
// resumo de disponibilidade para o bibliotecário decidir com contexto.
// 18/07/2026, "minha maior sugestão" da rodada seguinte: passou a mostrar
// também a previsão de devolução (só quando não há exemplar disponível
// agora — é o dado que importa nesse caso) e a fila atual por nome (evita
// reserva duplicada e responde "quem já está esperando" sem sair do
// formulário).
async function aoEscolherLivroReserva() {
  const livroId = raw('reservaLivro');
  const resumo = document.getElementById('reservaResumoLivro');
  if (!resumo) return;
  if (!livroId) {
    resumo.style.display = 'none';
    resumo.innerHTML = '';
    return;
  }
  resumo.style.display = '';
  resumo.innerHTML = '<span class="emprestimo-resumo-carregando">Carregando disponibilidade...</span>';
  const { data, error } = await LivroDisponibilidadeRepo.resumo(livroId);
  if (error || !data) {
    resumo.style.display = 'none';
    resumo.innerHTML = '';
    return;
  }
  const previsao =
    data.disponiveis === 0 && data.proximaDevolucao
      ? `<span class="emprestimo-resumo-item emprestimo-resumo-linha-cheia">Última devolução prevista: <strong>${fmtData(data.proximaDevolucao)}</strong></span>`
      : '';
  const fila = (data.fila || []).length
    ? `<div class="emprestimo-resumo-linha-cheia">
             <span class="emprestimo-resumo-item"><strong>Fila atual</strong></span>
             <ol class="reserva-fila-lista">
                 ${data.fila.map((r) => `<li>${sanitize(r.usuario_nome || '—')}</li>`).join('')}
             </ol>
         </div>`
    : '';
  resumo.innerHTML = `
        <span class="emprestimo-resumo-item"><strong>${data.disponiveis}</strong> disponível(is)</span>
        <span class="emprestimo-resumo-item"><strong>${data.emprestados}</strong> emprestado(s)</span>
        <span class="emprestimo-resumo-item"><strong>${data.reservas}</strong> reserva(s) ativa(s)</span>
        ${previsao}${fila}
    `;
}
async function createEmprestimo() {
  if (pendingOp) return;
  const usuario_id = raw('emprestimoUsuario');
  const exemplar_id = raw('emprestimoExemplar');
  if (!usuario_id) {
    showAlert('emprestimoModalAlert', 'Selecione o leitor.', 'error');
    return;
  }
  if (!raw('emprestimoLivro')) {
    showAlert('emprestimoModalAlert', 'Selecione o livro.', 'error');
    return;
  }
  if (!exemplar_id) {
    showAlert('emprestimoModalAlert', 'Selecione um exemplar disponível.', 'error');
    return;
  }
  pendingOp = true;
  const btn = document.getElementById('btnCadEmprestimo');
  btn.disabled = true;
  const res = await EmprestimoService.criar({
    usuario_id,
    exemplar_id,
    data_retirada: raw('emprestimoDataRetirada'),
    data_prevista: raw('emprestimoDataPrevista'),
  });
  btn.disabled = false;
  pendingOp = false;
  if (!res.ok) {
    showAlert('emprestimoModalAlert', res.message, 'error');
    return;
  }
  fecharModal('modalNovoEmprestimo');
  showAlert('emprestimoAlert', res.message, 'success');
  pageState.emprestimos = 1;
  await Promise.all([reloadExemplarSelects(), reloadUsuarioSelects(), reloadLivroSelects()]);
  await renderEmprestimos();
}

/* --- Modal "Registrar Devolução" (confirmação com preview de multa) ---
 * Substitui o antigo confirm() nativo (item 8 do pedido) — mostra livro,
 * exemplar, datas e a multa prevista antes de confirmar. O valor previsto
 * espelha exatamente a fórmula de registrar_devolucao() no backend (fonte
 * única de verdade); a multa real gravada pode diferir só se os dias
 * mudarem entre a abertura do modal e a confirmação (ex.: virada de dia). */
let _emprestimoDevolucaoId = null;
async function abrirModalDevolucao(id) {
  document.querySelectorAll('.action-menu.open').forEach((m) => m.classList.remove('open'));
  const { data: emp, error } = await EmprestimoRepo.detalhe(id);
  if (error || !emp) {
    showAlert('emprestimoAlert', 'Erro ao carregar empréstimo.', 'error');
    return;
  }
  _emprestimoDevolucaoId = id;
  document.getElementById('devolverLivroTitulo').textContent = emp.livro_titulo || '—';
  document.getElementById('devolverLeitorNome').textContent = emp.usuario_nome || '—';
  document.getElementById('devolverExemplar').textContent = emp.exemplar_codigo || '—';
  document.getElementById('devolverRetirada').textContent = fmtData(emp.data_retirada);
  document.getElementById('devolverPrevista').textContent = fmtData(emp.data_prevista);
  document.getElementById('devolverHoje').textContent = fmtData(todayStr());
  const diasWrap = document.getElementById('devolverDiasWrap');
  const multaWrap = document.getElementById('devolverMultaWrap');
  if (emp.dias_atraso > 0) {
    diasWrap.style.display = '';
    document.getElementById('devolverDias').textContent = `${emp.dias_atraso} dia(s)`;
    multaWrap.style.display = '';
    document.getElementById('devolverMulta').textContent = fmtMoeda(emp.multa_prevista ?? 0);
  } else {
    diasWrap.style.display = 'none';
    multaWrap.style.display = 'none';
  }
  abrirModal('modalDevolverEmprestimo');
}
async function confirmarDevolucao() {
  if (!_emprestimoDevolucaoId || pendingOp) return;
  const id = _emprestimoDevolucaoId;
  pendingOp = true;
  const btn = document.getElementById('btnConfirmarDevolucao');
  btn.disabled = true;
  const res = await EmprestimoService.devolver(id);
  btn.disabled = false;
  pendingOp = false;
  fecharModal('modalDevolverEmprestimo');
  showAlert('emprestimoAlert', res.message, res.ok ? 'success' : 'error');
  if (!res.ok) return;
  _emprestimoDevolucaoId = null;
  pageState.emprestimos = 1;
  await Promise.all([reloadExemplarSelects(), reloadUsuarioSelects()]);
  await renderEmprestimos();
}

/* --- Painel "Detalhes do Empréstimo" (kebab menu, item 9 do pedido) ---
 * Reaproveita a estrutura visual .detalhe-grid/.leitor-timeline* já criada
 * para Livros e para a Central do Leitor, com atalhos para os perfis
 * completos do leitor e do livro. */
// Sub-campos por evento (19/07/2026, "padronizar a timeline" — mesmo padrão
// visual de resumoEvento/detalhesEvento usado em Leitor/Livro). Diferente
// daquelas timelines, aqui NÃO repete Leitor/Exemplar em todo evento — já
// aparecem fixos no cabeçalho do modal (a timeline do Empréstimo é sempre
// sobre o mesmo leitor+exemplar do início ao fim, ao contrário da timeline
// de um Leitor/Livro, que mistura vários). Exceção: o evento "Empréstimo
// registrado" mostra Leitor/Exemplar mesmo assim (pedido explícito da
// quarta rodada de feedback, 19/07/2026) — é o único ponto da timeline que
// representa "o que foi combinado no início", então vale repetir ali.
// `emp` traz o contexto constante (dias_atraso, multa_valor) pros marcos
// sintéticos e pro evento de devolução, que não vêm por evento do backend
// (ver emprestimoDetalhe).
function detalhesEventoEmprestimo(ev, emp) {
  const L = (label, valor) => (valor === null || valor === undefined || valor === '' ? null : { label, valor });
  // meta:true (19/07/2026, "padronizar os eventos" — mesmo tratamento
  // aplicado a detalhesEvento/Leitor/Livro) — Responsável/Horário ganham um
  // divisor visual antes deles em linhasDetalheHTML.
  const M = (label, valor) =>
    valor === null || valor === undefined || valor === '' ? null : { label, valor, meta: true };
  const respLinha = M('Responsável', ev.responsavel ? String(ev.responsavel).split('@')[0] : null);
  const atrasoTxt = emp.dias_atraso > 0 ? `${emp.dias_atraso} dia${emp.dias_atraso === 1 ? '' : 's'}` : null;
  let linhas = [];
  switch (ev.tipo) {
    case 'emprestimo':
      linhas = [
        L('Leitor', emp.usuario_nome),
        L('Exemplar', emp.exemplar_codigo),
        L('Retirada', fmtData(emp.data_retirada)),
        L('Prazo previsto', fmtData(emp.data_prevista)),
        respLinha,
      ];
      break;
    case 'prazo_expirado':
      // Sem linha de "situação" própria (19/07/2026, sétima rodada de
      // feedback): antes afirmava "Livro ainda não devolvido", mas esse
      // marco passou a aparecer também em empréstimos já devolvidos com
      // atraso (ver emprestimoDetalhe, backend) — a frase ficaria falsa
      // nesse caso. O evento devolução, logo abaixo na timeline, já mostra
      // quantos dias de atraso houve.
      linhas = [];
      break;
    case 'devolucao':
      // Multa embutida aqui (19/07/2026, quarta rodada) em vez de um evento
      // "Multa gerada" à parte — é consequência direta e no mesmo instante
      // da devolução, não um acontecimento separado (ver emprestimoDetalhe).
      // Rótulo "Resultado" (19/07/2026, sétima rodada — mesma renomeação do
      // bloco Resumo, evita colidir com o sentido de "Situação" usado em
      // outras telas).
      linhas = [
        L('Resultado', atrasoTxt ? `${atrasoTxt} de atraso` : 'Dentro do prazo'),
        L('Multa', emp.multa_valor != null ? fmtMoeda(emp.multa_valor) : null),
        respLinha,
      ];
      break;
    case 'multa_paga':
      linhas = [respLinha];
      break;
    default:
      linhas = [respLinha];
  }
  if (ev.quando) linhas.push(M('Horário', fmtHora(ev.quando)));
  return linhas.filter(Boolean);
}
function renderEmprestimoTimeline(eventos, emp) {
  const el = document.getElementById('empDetalheTimeline');
  if (!el) return;
  if (!eventos || !eventos.length) {
    el.innerHTML = '<p class="leitor-timeline-vazia">Sem movimentações registradas.</p>';
    return;
  }
  el.innerHTML = `<div class="leitor-timeline-eventos">
        ${eventos
          .map((ev) => {
            const linhas = detalhesEventoEmprestimo(ev, emp);
            return `<div class="leitor-evento">
                <button type="button" class="leitor-evento-resumo" onclick="this.closest('.leitor-evento').classList.toggle('expandido')" aria-expanded="false">
                    <span class="leitor-evento-icone leitor-evento-icone--${ev.tipo}">${svgTimeline(ev.tipo)}</span>
                    <span class="leitor-evento-textos">
                        <span class="leitor-evento-titulo">${sanitize(ev.titulo)}${ev.valor != null ? ' · ' + fmtMoeda(ev.valor) : ''}</span>
                        <span class="leitor-evento-subtitulo">${fmtData(String(ev.quando).split('T')[0])}</span>
                    </span>
                    <svg class="leitor-evento-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                <div class="leitor-evento-detalhe">
                    ${linhasDetalheHTML(linhas)}
                </div>
            </div>`;
          })
          .join('')}
    </div>`;
}
let _emprestimoDetalheId = null;
async function abrirDetalhesEmprestimo(id) {
  _emprestimoDetalheId = id;
  document.querySelectorAll('.action-menu.open').forEach((m) => m.classList.remove('open'));
  const { data: emp, error } = await EmprestimoRepo.detalhe(id);
  if (error || !emp) {
    showAlert('emprestimoAlert', 'Erro ao carregar detalhes do empréstimo.', 'error');
    return;
  }
  document.getElementById('empDetalheLivroTitulo').textContent = emp.livro_titulo || '—';
  document.getElementById('empDetalheAutores').textContent = emp.autores || '—';
  document.getElementById('empDetalheExemplarCodigo').textContent = emp.exemplar_codigo || '';

  // Badge do cabeçalho (19/07/2026, quarta rodada): mesmas 3 cores da
  // tabela, mas calculado direto de emp.data_devolucao/dias_atraso — NÃO dá
  // pra reaproveitar situacaoEmprestimoBadge(emp) aqui porque o vocabulário
  // de emp.situacao nesta resposta (emprestimoDetalhe) é diferente do de
  // vw_emprestimos_lista ("Devolvido com atraso"/"Devolvido no prazo" em vez
  // de "Devolvido"), e cairia sempre no caso padrão "Em andamento". A
  // distinção "com atraso" que o usuário também pediu no cabeçalho vive
  // melhor no bloco Resumo logo abaixo (Status + Situação separados),
  // evitando duplicar a mesma informação com duas redações diferentes.
  const sitBadge = emp.data_devolucao
    ? { texto: 'Devolvido', classe: 'success' }
    : emp.dias_atraso > 0
      ? { texto: 'Atrasado', classe: 'danger' }
      : { texto: 'Em andamento', classe: 'info' };
  document.getElementById('empDetalheStatusBadge').innerHTML =
    `<span class="badge badge-${sitBadge.classe}">${sanitize(sitBadge.texto)}</span>`;

  // Bloco Resumo (19/07/2026, quarta rodada — "assim o usuário entende
  // rapidamente o estado daquele empréstimo antes de olhar a timeline").
  document.getElementById('empDetalheStatus').textContent = emp.data_devolucao ? 'Devolvido' : 'Em andamento';
  document.getElementById('empDetalheSituacao').textContent = emp.dias_atraso > 0 ? 'Com atraso' : 'No prazo';
  document.getElementById('empDetalheRetirada').textContent = fmtData(emp.data_retirada);
  document.getElementById('empDetalhePrevista').textContent = fmtData(emp.data_prevista);

  const devolucaoWrap = document.getElementById('empDetalheDevolucaoWrap');
  if (emp.data_devolucao) {
    devolucaoWrap.style.display = '';
    document.getElementById('empDetalheDevolucao').textContent = fmtData(emp.data_devolucao);
  } else {
    devolucaoWrap.style.display = 'none';
  }
  const diasWrap = document.getElementById('empDetalheDiasWrap');
  if (emp.dias_atraso > 0) {
    diasWrap.style.display = '';
    document.getElementById('empDetalheDias').textContent = `${emp.dias_atraso} dia(s)`;
  } else {
    diasWrap.style.display = 'none';
  }
  // Responsável escondido quando vazio (19/07/2026, sétima rodada de
  // feedback) — antes mostrava "—" mesmo sem dado, o que parecia informação
  // faltando em vez de "não se aplica".
  const respWrap = document.getElementById('empDetalheResponsavelWrap');
  if (respWrap) {
    if (emp.responsavel) {
      respWrap.style.display = '';
      document.getElementById('empDetalheResponsavel').textContent = String(emp.responsavel).split('@')[0];
    } else {
      respWrap.style.display = 'none';
    }
  }

  // Bloco Relacionados (19/07/2026, quarta rodada — "conecta todas as telas
  // do sistema"): Livro/Leitor/Exemplar navegam pro detalhe de cada um;
  // Multa fica só informativa (sem tela de detalhe própria hoje, ver
  // comentário no HTML).
  const btnLivro = document.getElementById('empDetalheAbrirLivro');
  if (btnLivro) {
    btnLivro.textContent = emp.livro_titulo || '—';
    btnLivro.onclick = () => {
      fecharModal('modalDetalhesEmprestimo');
      abrirDetalhesLivro(emp.livro_id);
    };
  }
  const btnLeitor = document.getElementById('empDetalheAbrirLeitor');
  if (btnLeitor) {
    btnLeitor.textContent = emp.usuario_nome || '—';
    btnLeitor.onclick = () => {
      fecharModal('modalDetalhesEmprestimo');
      abrirDetalhesLeitor(emp.usuario_id);
    };
  }
  const btnExemplar = document.getElementById('empDetalheExemplar');
  if (btnExemplar) {
    btnExemplar.textContent = emp.exemplar_codigo || '—';
    btnExemplar.onclick = emp.exemplar_id
      ? () => {
          fecharModal('modalDetalhesEmprestimo');
          abrirDetalheExemplar(emp.exemplar_id);
        }
      : null;
  }
  const multaWrap = document.getElementById('empDetalheMultaWrap');
  if (emp.multa_valor != null) {
    multaWrap.style.display = '';
    document.getElementById('empDetalheMulta').textContent =
      fmtMoeda(emp.multa_valor) + (emp.multa_pago ? ' (paga)' : ' (pendente)');
  } else {
    multaWrap.style.display = 'none';
  }
  // Multa atual (19/07/2026, feedback de design anterior): prévia pro
  // empréstimo que ainda está em atraso e sem multa gravada — evita que o
  // bibliotecário precise abrir a tela de Multas só pra saber o valor.
  const multaPrevistaWrap = document.getElementById('empDetalheMultaPrevistaWrap');
  if (multaPrevistaWrap) {
    if (emp.multa_prevista != null) {
      multaPrevistaWrap.style.display = '';
      document.getElementById('empDetalheMultaPrevista').textContent = fmtMoeda(emp.multa_prevista);
    } else {
      multaPrevistaWrap.style.display = 'none';
    }
  }

  const btnDevolver = document.getElementById('empDetalheBtnDevolver');
  if (btnDevolver) {
    if (podeEscrever() && !emp.data_devolucao) {
      btnDevolver.style.display = '';
      btnDevolver.onclick = () => {
        fecharModal('modalDetalhesEmprestimo');
        abrirModalDevolucao(emp.emprestimo_id);
      };
    } else {
      btnDevolver.style.display = 'none';
    }
  }
  // Empréstimo já concluído (19/07/2026, feedback de design): em vez do
  // botão de devolução simplesmente sumir sem nada no lugar, oferece o
  // próximo passo mais provável — um novo empréstimo pro mesmo leitor, com
  // o campo Leitor já travado (mesmo padrão de novaAcaoParaLeitor).
  const btnNovo = document.getElementById('empDetalheBtnNovoEmprestimo');
  if (btnNovo) {
    if (podeEscrever() && emp.data_devolucao) {
      btnNovo.style.display = '';
      btnNovo.onclick = () => {
        fecharModal('modalDetalhesEmprestimo');
        abrirModalNovoEmprestimo();
        fixarLeitorNoFormulario('emprestimo', emp.usuario_id, emp.usuario_nome);
        setTimeout(() => document.getElementById('emprestimoLivro')?.focus(), 100);
      };
    } else {
      btnNovo.style.display = 'none';
    }
  }

  renderEmprestimoTimeline(emp.eventos || [], emp);
  abrirModal('modalDetalhesEmprestimo');
}

/* ---------- Reservas ---------- */
// Badge de posição na fila (17/07/2026, feedback de design) — sem emoji
// (medalhas 🥇🥈🥉 sugeridas foram descartadas, mantendo o padrão já
// confirmado com o usuário de badges só por cor). 1ª posição usa
// badge-warning (dourado, "é a próxima a ser atendida"); as demais usam
// badge-info (neutro), só para não competir visualmente com a 1ª.
function filaBadgeHTML(fila) {
  if (fila == null) return '&#8212;';
  const classe = fila === 1 ? 'badge-warning' : 'badge-info';
  return `<span class="badge ${classe}">${fila}ª</span>`;
}
// Guarda a última página de linhas carregadas — abrirDetalheReserva() lê
// daqui em vez de refazer uma chamada à API (mesmo padrão de
// _auditoriaCache, ver abrirDetalheAuditoria).
let _reservasCache = [];
async function renderReservas() {
  const term = searchTerm('reservasSearch');
  await renderPaginado({
    tbodyId: 'reservasTable',
    paginationId: 'reservasPagination',
    colspan: 6,
    section: 'reservas',
    fetch: () =>
      ReservaRepo.pagina({ page: pageState.reservas, pageSize: PAGE_SIZE, q: term, status: reservaFiltroStatus }),
    // 18/07/2026: quando há filtro por status (clique num KPI), o hint deixa
    // isso explícito — sem esse aviso, "2 registro(s)" parece um resultado
    // de busca vazio, não um filtro ativo.
    onCount: (count) => {
      const hintEl = document.getElementById('reservasHint');
      if (!hintEl) return;
      const n = Number(count) || 0;
      if (term) hintEl.textContent = `${n} resultado(s) para "${term}"`;
      else if (reservaFiltroStatus) hintEl.textContent = `${n} reserva(s) — filtrando por "${reservaFiltroStatus}"`;
      else hintEl.textContent = `${n} reserva(s)`;
    },
    emptyMsg: 'Nenhuma reserva encontrada.',
    filterRows: (rows) => {
      _reservasCache = rows;
      return rows;
    },
    rowFn: (r) => {
      const bc = r.status === 'Ativa' ? 'success' : r.status === 'Atendida' ? 'info' : 'danger';
      const acoes =
        podeEscrever() && r.status === 'Ativa'
          ? `<button class="btn btn-success btn-sm" onclick="event.stopPropagation();updateReservaStatus('${r.reserva_id}','Atendida')" aria-label="Marcar como atendida">Marcar como atendida</button>
               <button class="btn btn-danger btn-sm"  onclick="event.stopPropagation();updateReservaStatus('${r.reserva_id}','Cancelada')" aria-label="Cancelar">Cancelar</button>`
          : '&#8212;';
      return `<tr class="clickable-row" data-id="${r.reserva_id}" onclick="abrirDetalheReserva(this.dataset.id)">
            <td data-label="Livro">${destacarTrecho(r.livro_titulo, term)}</td>
            <td data-label="Leitor">${destacarTrecho(r.usuario_nome, term)}</td>
            <td data-label="Fila">${r.status === 'Ativa' ? filaBadgeHTML(r.fila) : '&#8212;'}</td>
            <td data-label="Status"><span class="badge badge-${bc}">${sanitize(r.status)}</span></td>
            <td data-label="Reserva em">${fmtData(r.data_reserva)}</td>
            <td class="td-actions" onclick="event.stopPropagation()">${acoes}</td>
        </tr>`;
    },
  });
}
// Modal de Detalhes da Reserva (18/07/2026, feedback de design) — a fila
// completa do livro só faz sentido no detalhe, não na tabela (mesmo
// raciocínio "lista localiza, detalhe analisa" do Achado 33). Reaproveita
// livroResumoDisponibilidade (já traz a fila ordenada) em vez de criar uma
// ação de backend só para isto.
async function abrirDetalheReserva(id) {
  const r = _reservasCache.find((x) => String(x.reserva_id) === String(id));
  if (!r) return;
  document.getElementById('resDetalheLivro').textContent = r.livro_titulo || '—';
  document.getElementById('resDetalheLeitor').textContent = r.usuario_nome || '—';
  const bc = r.status === 'Ativa' ? 'success' : r.status === 'Atendida' ? 'info' : 'danger';
  document.getElementById('resDetalheStatus').innerHTML =
    `<span class="badge badge-${bc}">${sanitize(r.status)}</span>`;
  document.getElementById('resDetalheData').textContent = fmtData(r.data_reserva);

  const acoesEl = document.getElementById('resDetalheAcoes');
  const acoes =
    podeEscrever() && r.status === 'Ativa'
      ? `<button class="btn btn-success btn-sm" onclick="fecharModal('modalDetalheReserva');updateReservaStatus('${r.reserva_id}','Atendida')">Marcar como atendida</button>
           <button class="btn btn-danger btn-sm" onclick="fecharModal('modalDetalheReserva');updateReservaStatus('${r.reserva_id}','Cancelada')">Cancelar</button>`
      : '';
  acoesEl.innerHTML = `${acoes}<button class="btn btn-danger btn-sm" onclick="fecharModal('modalDetalheReserva')">Fechar</button>`;

  const filaBloco = document.getElementById('resDetalheFilaBloco');
  const filaEl = document.getElementById('resDetalheFila');
  if (r.status !== 'Ativa' || !r.livro_id) {
    filaBloco.style.display = 'none';
  } else {
    filaBloco.style.display = '';
    filaEl.innerHTML = '<p class="livro-lista-vazia">Carregando fila...</p>';
    const { data } = await LivroDisponibilidadeRepo.resumo(r.livro_id);
    const fila = data?.fila || [];
    document.getElementById('resDetalheFilaTitulo').textContent = `Fila completa (${fila.length})`;
    filaEl.innerHTML = fila.length
      ? fila
          .map(
            (
              f,
              idx,
            ) => `<div class="livro-reserva-item${String(f.reserva_id) === String(r.reserva_id) ? ' livro-reserva-item-atual' : ''}">
                <span class="livro-reserva-nome">${sanitize(f.usuario_nome || '—')}</span>
                <span class="livro-reserva-fila">${idx + 1}ª posição</span>
            </div>`,
          )
          .join('')
      : '<p class="livro-lista-vazia">Nenhuma reserva ativa para este livro.</p>';
  }
  abrirModal('modalDetalheReserva');
}
async function createReserva() {
  if (pendingOp) return;
  pendingOp = true;
  const btn = document.getElementById('btnCadReserva');
  btn.disabled = true;
  const res = await ReservaService.criar({ usuario_id: raw('reservaUsuario'), livro_id: raw('reservaLivro') });
  btn.disabled = false;
  pendingOp = false;
  showAlert('reservaAlert', res.message, res.ok ? 'success' : 'error');
  if (!res.ok) return;
  pageState.reservas = 1;
  loadReservasKpis();
  aoEscolherLivroReserva(); // atualiza o resumo de disponibilidade (a nova reserva já conta)
  await renderReservas();
}
async function updateReservaStatus(id, status) {
  if (pendingOp) return;
  pendingOp = true;
  const res = await ReservaService.atualizarStatus(id, status);
  pendingOp = false;
  showAlert('reservaAlert', res.message, res.ok ? 'success' : 'error');
  if (!res.ok) return;
  loadReservasKpis();
  await renderReservas();
}

/* ---------- Multas ---------- */
async function renderMultas() {
  const term = searchTerm('multasSearch');
  await renderPaginado({
    tbodyId: 'multasTable',
    paginationId: 'multasPagination',
    colspan: 8,
    section: 'multas',
    fetch: () => MultaRepo.pagina({ page: pageState.multas, pageSize: PAGE_SIZE, q: term }),
    onCount: (count) => updateHint('multasHint', count, term),
    emptyMsg: 'Nenhuma multa encontrada.',
    rowFn: (m) => {
      const total = Number(m.total || 0);
      const acoes =
        podeEscrever() && !m.pago
          ? `<button class="btn btn-success btn-sm" onclick="pagarMulta('${m.multa_id}')" aria-label="Pagar multa">Pagar</button>`
          : '&#8212;';
      return `<tr>
            <td data-label="ID" title="${m.multa_id}">${String(m.multa_id).slice(0, 8)}</td>
            <td data-label="Leitor">${destacarTrecho(m.usuario_nome, term) || 'N/A'}</td>
            <td data-label="Livro">${destacarTrecho(m.livro_titulo, term) || 'N/A'}</td>
            <td data-label="Dias">${m.dias}${m.aberto ? ' *' : ''}</td>
            <td data-label="Valor/Dia">${fmtMoeda(m.valor_dia)}</td>
            <td data-label="Total"><strong>${fmtMoeda(total)}${m.aberto ? ' *' : ''}</strong></td>
            <td data-label="Situação">${m.pago ? '<span class="badge badge-success">Pago</span>' : '<span class="badge badge-danger">Pendente</span>'}</td>
            <td class="td-actions">${acoes}</td>
        </tr>`;
    },
    extraRowsHtml: (rows) =>
      rows.some((m) => m.aberto)
        ? '<tr class="note-row"><td colspan="8">* Em aberto — valor atualizado diariamente até a devolução.</td></tr>'
        : '',
  });
}
async function pagarMulta(id) {
  if (pendingOp) return;
  if (!confirm('Confirmar registro do pagamento desta multa?')) return;
  pendingOp = true;
  const res = await MultaService.pagar(id);
  pendingOp = false;
  showAlert('multaAlert', res.message, res.ok ? 'success' : 'error');
  if (!res.ok) return;
  await renderMultas();
}

/* ---------- Auditoria ---------- */
// Guarda a última página de linhas carregadas — abrirDetalheAuditoria() lê
// daqui em vez de refazer uma chamada à API (a linha já tem tudo que o
// modal de detalhes precisa, ver vw_log_auditoria_lista).
let _auditoriaCache = [];

// Traduz o filtro de Período (Hoje/Esta semana/Este mês/Personalizado) em
// datas de/até (ISO local) para os filtros gte/lte de buscar_pagina() — ver
// case 'auditoriaPagina' na Edge Function.
function calcularPeriodoAuditoria() {
  const sel = document.getElementById('auditoriaFiltroPeriodo')?.value || '';
  const fimHoje = `${todayStr()}T23:59:59`;
  if (sel === 'hoje') return { de: `${todayStr()}T00:00:00`, ate: fimHoje };
  if (sel === 'semana') {
    const hoje = new Date();
    const diffSegunda = (hoje.getDay() + 6) % 7; // dias desde a última segunda-feira
    const seg = new Date(hoje);
    seg.setDate(hoje.getDate() - diffSegunda);
    return { de: `${seg.toISOString().split('T')[0]}T00:00:00`, ate: fimHoje };
  }
  if (sel === 'mes') return { de: `${todayStr().slice(0, 7)}-01T00:00:00`, ate: fimHoje };
  if (sel === 'personalizado') {
    const de = raw('auditoriaPeriodoDe');
    const ate = raw('auditoriaPeriodoAte');
    return { de: de ? `${de}T00:00:00` : '', ate: ate ? `${ate}T23:59:59` : '' };
  }
  return { de: '', ate: '' };
}

// Mostra/esconde os campos "Personalizado"; com um período pronto (não
// personalizado) já dispara o refresh — "Personalizado" espera o usuário
// escolher as datas (onchange dos próprios campos já chama renderAuditoria()).
function onAuditoriaPeriodoChange() {
  const custom = (document.getElementById('auditoriaFiltroPeriodo')?.value || '') === 'personalizado';
  document.getElementById('auditoriaPeriodoDe').style.display = custom ? '' : 'none';
  document.getElementById('auditoriaPeriodoAte').style.display = custom ? '' : 'none';
  pageState.auditoria = 1;
  if (!custom) renderAuditoria();
}

// Popula o filtro "Usuário" com os e-mails distintos que já têm registro de
// auditoria (mesma restrição de RBAC de auditoriaPagina — ver ACOES_STAFF_APENAS).
async function reloadAuditoriaUsuarioSelect() {
  const sel = document.getElementById('auditoriaFiltroUsuario');
  if (!sel) return;
  const atual = sel.value;
  const { data } = await AuditoriaRepo.usuarios();
  sel.innerHTML =
    '<option value="">Todos os usuários</option>' +
    (data || []).map((e) => `<option value="${sanitize(e)}">${sanitize(e)}</option>`).join('');
  if (atual) sel.value = atual;
}

// Popula o filtro "Ação" a partir do mesmo mapa de rótulos usado na lista —
// ACAO_PT é a única fonte de rótulos em português para `acao`.
function popularAuditoriaFiltroAcao() {
  const sel = document.getElementById('auditoriaFiltroAcao');
  if (!sel) return;
  const atual = sel.value;
  sel.innerHTML =
    '<option value="">Todas as ações</option>' +
    Object.entries(ACAO_PT)
      .map(([valor, rotulo]) => `<option value="${valor}">${sanitize(rotulo)}</option>`)
      .join('');
  if (atual) sel.value = atual;
}

async function renderAuditoria() {
  const term = searchTerm('auditoriaSearch');
  const usuario = document.getElementById('auditoriaFiltroUsuario')?.value || '';
  const acao = document.getElementById('auditoriaFiltroAcao')?.value || '';
  const entidade = document.getElementById('auditoriaFiltroEntidade')?.value || '';
  const { de, ate } = calcularPeriodoAuditoria();
  await renderPaginado({
    tbodyId: 'auditoriaTable',
    paginationId: 'auditoriaPagination',
    colspan: 5,
    section: 'auditoria',
    fetch: () =>
      AuditoriaRepo.pagina({
        page: pageState.auditoria,
        pageSize: PAGE_SIZE,
        q: term,
        usuario,
        acao,
        entidade,
        de,
        ate,
      }),
    onCount: (count) => updateHint('auditoriaHint', count, term),
    emptyMsg: 'Nenhum registro de auditoria encontrado.',
    filterRows: (rows) => {
      _auditoriaCache = rows;
      return rows;
    },
    rowFn: (r) => {
      const quando = r.criado_em ? `${fmtData(r.criado_em)} ${fmtHora(r.criado_em)}` : '—';
      const quem = (r.usuario_email || '').split('@')[0] || '—';
      const descr = ACAO_PT[r.acao] || r.acao;
      const codigo = r.registro_id ? String(r.registro_id).slice(0, 8) : '—';
      return `<tr class="clickable-row" data-id="${r.id}" onclick="abrirDetalheAuditoria(this.dataset.id)">
            <td data-label="Data/Hora">${quando}</td>
            <td data-label="Usuário">${sanitize(quem)}</td>
            <td data-label="Ação">${destacarTrecho(descr, term)}</td>
            <td data-label="Entidade">${sanitize(ENTIDADE_PT[r.entidade] || r.entidade || '—')}</td>
            <td data-label="Código" title="${sanitize(r.registro_id || '')}">${sanitize(codigo)}</td>
        </tr>`;
    },
  });
}

function abrirDetalheAuditoria(id) {
  const r = _auditoriaCache.find((x) => String(x.id) === String(id));
  if (!r) return;
  document.getElementById('audDetalheUsuario').textContent = r.usuario_email || '—';
  document.getElementById('audDetalheData').textContent = r.criado_em
    ? `${fmtData(r.criado_em)} às ${fmtHora(r.criado_em)}`
    : '—';
  document.getElementById('audDetalheEntidade').textContent = ENTIDADE_PT[r.entidade] || r.entidade || '—';
  document.getElementById('audDetalheCodigo').textContent = r.registro_id || '—';

  const alteracoes = r.detalhe?.alteracoes;
  const wrap = document.getElementById('audDetalheAlteracoes');
  if (Array.isArray(alteracoes) && alteracoes.length) {
    // Caso "Campo alterado / Valor anterior / Novo valor" — usuario.atualizar,
    // exemplar.status e reserva.status capturam o "antes" (ver Edge Function).
    wrap.innerHTML = `<h4 class="livro-detalhe-subtitulo">O que mudou</h4>
        <div class="auditoria-alteracoes">
            ${alteracoes
              .map(
                (a) => `<div class="auditoria-alteracao-item">
                    <span class="auditoria-alteracao-campo">${sanitize(a.campo)}</span>
                    <span class="auditoria-alteracao-de">${sanitize(a.de ?? '—')}</span>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="auditoria-alteracao-seta"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                    <span class="auditoria-alteracao-para">${sanitize(a.para ?? '—')}</span>
                </div>`,
              )
              .join('')}
        </div>`;
  } else if (r.detalhe && Object.keys(r.detalhe).length) {
    // Ações sem diff estruturado (ex.: livro.atualizar, multa.pagar) ainda
    // mostram o que foi registrado, em formato bruto label:valor — decisão
    // documentada na Achado 26 (nem toda ação captura "antes/depois").
    wrap.innerHTML = `<h4 class="livro-detalhe-subtitulo">Detalhes registrados</h4>
        <div class="detalhe-grid">
            ${Object.entries(r.detalhe)
              .map(
                ([k, v]) =>
                  `<div class="detalhe-item"><span class="detalhe-label">${sanitize(k)}</span><span class="detalhe-valor">${sanitize(String(v))}</span></div>`,
              )
              .join('')}
        </div>`;
  } else {
    wrap.innerHTML = '<p class="leitor-timeline-vazia">Nenhum detalhe adicional registrado para esta ação.</p>';
  }
  abrirModal('modalDetalheAuditoria');
}

/* ---------- Perfis (RBAC — somente admin) ---------- */
const PAPEL_LABEL = { admin: 'Administrador', bibliotecario: 'Bibliotecário', consulta: 'Consulta' };
// Descrições curtas por papel (18/07/2026, feedback de design, item 3) —
// mostradas abaixo do <select> "Papel" no formulário, para o admin não
// precisar decorar o que cada papel pode fazer.
const PAPEL_DESCRICAO = {
  admin: 'Acesso completo ao sistema.',
  bibliotecario: 'Gerencia livros, empréstimos, reservas e multas.',
  consulta: 'Apenas visualização, sem permissão para alterar dados.',
};
function aoEscolherPapelPerfil() {
  const el = document.getElementById('perfilPapelDescricao');
  if (el) el.textContent = PAPEL_DESCRICAO[raw('perfilPapel')] || '';
}

let _perfisCache = [];
let perfilFiltroTipo = null; // 'admin' | 'bibliotecario' | 'consulta' | 'pendente' | null

// KPIs (18/07/2026, feedback de design, "eu adicionaria indicadores") —
// contados em memória a partir da lista já carregada (tela administrativa
// pequena, sem paginação no servidor) e clicáveis como filtro, mesmo
// padrão de filtrarReservasPorStatus (Achado 34).
function atualizarPerfisKpis(rows) {
  const porPapel = { admin: 0, bibliotecario: 0, consulta: 0 };
  let pendentes = 0;
  for (const pf of rows) {
    if (porPapel[pf.papel] != null) porPapel[pf.papel]++;
    if (!pf.user_id) pendentes++;
  }
  document.getElementById('pfKpiAdmin').textContent = porPapel.admin;
  document.getElementById('pfKpiBiblio').textContent = porPapel.bibliotecario;
  document.getElementById('pfKpiConsulta').textContent = porPapel.consulta;
  document.getElementById('pfKpiPendentes').textContent = pendentes;
}
function filtrarPerfisPorTipo(tipo) {
  perfilFiltroTipo = perfilFiltroTipo === tipo ? null : tipo;
  const marcar = (id, ativo) => document.getElementById(id)?.classList.toggle('usuarios-kpi-selecionado', ativo);
  marcar('pfKpiAdminCard', perfilFiltroTipo === 'admin');
  marcar('pfKpiBiblioCard', perfilFiltroTipo === 'bibliotecario');
  marcar('pfKpiConsultaCard', perfilFiltroTipo === 'consulta');
  marcar('pfKpiPendentesCard', perfilFiltroTipo === 'pendente');
  renderizarLinhasPerfis();
}

const perfisBadgeCor = { admin: 'danger', bibliotecario: 'info', consulta: 'warning' };
function renderizarLinhasPerfis() {
  const tbody = document.getElementById('perfisTable');
  const rows = perfilFiltroTipo
    ? _perfisCache.filter((pf) => (perfilFiltroTipo === 'pendente' ? !pf.user_id : pf.papel === perfilFiltroTipo))
    : _perfisCache;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Nenhum perfil encontrado para este filtro.</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map(
      (pf) => `<tr class="clickable-row" data-id="${pf.email}" onclick="abrirDetalhePerfil(this.dataset.id)">
        <td data-label="Email">${sanitize(pf.email) || '&#8212;'}</td>
        <td data-label="Papel"><span class="badge badge-${perfisBadgeCor[pf.papel] || 'info'}">${sanitize(PAPEL_LABEL[pf.papel] || pf.papel)}</span></td>
        <td data-label="Status">${pf.user_id ? '<span class="badge badge-success">Vinculado</span>' : '<span class="badge badge-warning">Pendente</span>'}</td>
        <td data-label="Último acesso">${pf.ultimo_acesso ? fmtData(pf.ultimo_acesso) : '<span class="text-muted">Nunca acessou</span>'}</td>
    </tr>`,
    )
    .join('');
}

async function renderPerfis() {
  const tbody = document.getElementById('perfisTable');
  tbody.innerHTML = '<tr><td colspan="4" class="loading">Carregando...</td></tr>';
  const { data, error } = await PerfilRepo.listar();
  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-state">Erro: ${sanitize(error.message)}</td></tr>`;
    return;
  }
  _perfisCache = data || [];
  if (!_perfisCache.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Nenhum perfil cadastrado.</td></tr>';
    atualizarPerfisKpis([]);
    return;
  }
  atualizarPerfisKpis(_perfisCache);
  renderizarLinhasPerfis();
}

async function definirPapel() {
  if (pendingOp) return;
  const email = val('perfilEmail'),
    papel = raw('perfilPapel');
  if (!email) {
    showAlert('perfilAlert', 'Informe o e-mail do usuário.', 'error');
    return;
  }
  pendingOp = true;
  const btn = document.getElementById('btnDefinirPapel');
  btn.disabled = true;
  const res = await PerfilRepo.definir(email, papel);
  btn.disabled = false;
  pendingOp = false;
  showAlert('perfilAlert', res.message, res.ok ? 'success' : 'error');
  if (!res.ok) return;
  document.getElementById('perfilEmail').value = '';
  await renderPerfis();
}

// Preenche o formulário "Conceder acesso" com os dados do perfil clicado no
// modal de detalhe (18/07/2026, feedback de design, "Alterar papel") — a
// própria ação de definirPapel() já faz upsert por e-mail, então reenviar o
// formulário atualiza o papel existente em vez de criar um perfil novo.
function alterarPapelPerfil(email, papel) {
  fecharModal('modalDetalhePerfil');
  document.getElementById('perfilEmail').value = email;
  document.getElementById('perfilPapel').value = papel;
  aoEscolherPapelPerfil();
  document.getElementById('perfilEmail').scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('perfilPapel').focus();
}

async function copiarEmailPerfil(email) {
  try {
    await navigator.clipboard.writeText(email);
    showAlert('perfilAlert', `E-mail ${email} copiado.`, 'success');
  } catch {
    showAlert('perfilAlert', 'Não foi possível copiar o e-mail.', 'error');
  }
}

async function reenviarConvitePerfil(email) {
  if (pendingOp) return;
  pendingOp = true;
  const res = await PerfilRepo.reenviarConvite(email);
  pendingOp = false;
  showAlert('perfilAlert', res.message, res.ok ? 'success' : 'error');
}

async function removerPerfil(email) {
  if (pendingOp) return;
  if (!confirm(`Remover o perfil de ${email}? A conta perde o acesso ao sistema.`)) return;
  pendingOp = true;
  const res = await PerfilRepo.remover(email);
  pendingOp = false;
  showAlert('perfilAlert', res.message, res.ok ? 'success' : 'error');
  if (!res.ok) return;
  fecharModal('modalDetalhePerfil');
  await renderPerfis();
}

function abrirDetalhePerfil(email) {
  const pf = _perfisCache.find((x) => x.email === email);
  if (!pf) return;
  document.getElementById('pfDetalheEmail').textContent = pf.email || '—';
  document.getElementById('pfDetalhePapel').innerHTML =
    `<span class="badge badge-${perfisBadgeCor[pf.papel] || 'info'}">${sanitize(PAPEL_LABEL[pf.papel] || pf.papel)}</span>` +
    (PAPEL_DESCRICAO[pf.papel] ? `<br /><small>${sanitize(PAPEL_DESCRICAO[pf.papel])}</small>` : '');
  document.getElementById('pfDetalheStatus').innerHTML = pf.user_id
    ? '<span class="badge badge-success">Vinculado</span>'
    : '<span class="badge badge-warning">Pendente</span>';
  document.getElementById('pfDetalheUltimoAcesso').textContent = pf.ultimo_acesso
    ? fmtData(pf.ultimo_acesso)
    : 'Nunca acessou';
  document.getElementById('pfDetalheCriadoEm').textContent = pf.created_at ? fmtData(pf.created_at) : '—';
  document.getElementById('pfDetalheCriadoPor').textContent = pf.criado_por || '—';

  const acoesEl = document.getElementById('pfDetalheAcoes');
  const acoes = podeEscrever()
    ? [
        `<button class="btn btn-outline btn-sm" onclick="alterarPapelPerfil('${pf.email}','${pf.papel}')">Alterar papel</button>`,
        `<button class="btn btn-outline btn-sm" onclick="copiarEmailPerfil('${pf.email}')">Copiar e-mail</button>`,
        !pf.user_id
          ? `<button class="btn btn-outline btn-sm" onclick="reenviarConvitePerfil('${pf.email}')">Reenviar convite</button>`
          : '',
        `<button class="btn btn-danger btn-sm" onclick="removerPerfil('${pf.email}')">Remover perfil</button>`,
      ].join('')
    : '';
  acoesEl.innerHTML = `${acoes}<button class="btn btn-danger btn-sm" onclick="fecharModal('modalDetalhePerfil')">Fechar</button>`;
  abrirModal('modalDetalhePerfil');
}

/* ---------- Meu Perfil ---------- */
function fmtCPF(cpf) {
  const c = String(cpf || '').replace(/\D/g, '');
  return c.length === 11 ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : cpf || '';
}

async function renderMeuPerfil(focusSection) {
  const { data, error } = await PerfilRepo.meusDados();
  if (error) {
    showAlert('meuPerfilAlert', 'Não foi possível carregar seus dados.', 'error');
    return;
  }

  const nome = data?.nome || '';
  const inicial = (nome || usuarioEmail || 'U')[0].toUpperCase();
  const avatarEl = document.getElementById('meuPerfilAvatar');
  if (avatarEl) avatarEl.textContent = inicial;

  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v || '';
  };
  set('meuPerfilNome', nome);
  set('meuPerfilEmail', data?.email || usuarioEmail || '');
  set('meuPerfilTelefone', data?.telefone || '');
  set('meuPerfilCPF', fmtCPF(data?.cpf));

  const PAPEL_PT = { admin: 'Administrador', bibliotecario: 'Bibliotecário', consulta: 'Consulta' };
  const BC = { admin: 'danger', bibliotecario: 'warning', consulta: 'info' };
  const papelEl = document.getElementById('meuPerfilPapelDisplay');
  if (papelEl)
    papelEl.innerHTML = `<span class="badge badge-${BC[papelAtual] || 'info'}">${PAPEL_PT[papelAtual] || papelAtual}</span>`;

  const statusEl = document.getElementById('meuPerfilStatusDisplay');
  if (statusEl)
    statusEl.innerHTML =
      data?.ativo !== false
        ? '<span class="badge badge-success">Ativo</span>'
        : '<span class="badge badge-danger">Inativo</span>';

  const criadoEl = document.getElementById('meuPerfilCriadoEm');
  const rawDate = data?.data_cadastro || null;
  if (criadoEl) criadoEl.textContent = rawDate ? fmtData(String(rawDate).split('T')[0]) : '—';

  if (focusSection === 'security') {
    setTimeout(
      () => document.getElementById('cardSeguranca')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      120,
    );
  }
}

async function salvarMeuPerfil() {
  const btn = document.getElementById('btnSalvarMeuPerfil');
  const telefone = document.getElementById('meuPerfilTelefone')?.value.trim();
  if (!nome) {
    showAlert('meuPerfilAlert', 'Nome é obrigatório.', 'error');
    return;
  }
  btn.disabled = true;
  const res = await PerfilRepo.atualizar({ nome, telefone });
  btn.disabled = false;
  showAlert(
    'meuPerfilAlert',
    res.message || (res.ok ? 'Perfil atualizado!' : 'Erro ao salvar.'),
    res.ok ? 'success' : 'error',
  );
  if (res.ok) {
    document.getElementById('userDisplayName').textContent = nome.split(' ')[0];
    const newInicial = nome[0].toUpperCase();
    const avatarEl = document.getElementById('meuPerfilAvatar');
    const headerAvatar = document.getElementById('userAvatar');
    if (avatarEl) avatarEl.textContent = newInicial;
    if (headerAvatar) headerAvatar.textContent = newInicial;
  }
}

async function alterarSenha() {
  const btn = document.getElementById('btnAlterarSenha');
  const atual = document.getElementById('senhaAtual')?.value;
  const nova = document.getElementById('senhaNova')?.value;
  const confirm = document.getElementById('senhaConfirmar')?.value;
  if (!atual || !nova || !confirm) {
    showAlert('meuPerfilSenhaAlert', 'Preencha todos os campos.', 'error');
    return;
  }
  if (nova.length < 6) {
    showAlert('meuPerfilSenhaAlert', 'A nova senha deve ter pelo menos 6 caracteres.', 'error');
    return;
  }
  if (nova !== confirm) {
    showAlert('meuPerfilSenhaAlert', 'As senhas não coincidem.', 'error');
    return;
  }
  btn.disabled = true;
  const email = document.getElementById('meuPerfilEmail')?.value || usuarioEmail;
  const reautent = await AuthService.reautenticar(email, atual);
  if (!reautent.ok) {
    btn.disabled = false;
    showAlert('meuPerfilSenhaAlert', 'Senha atual incorreta.', 'error');
    return;
  }
  const res = await AuthService.alterarSenha(nova);
  btn.disabled = false;
  if (!res.ok) {
    showAlert('meuPerfilSenhaAlert', 'Erro ao alterar senha: ' + res.message, 'error');
    return;
  }
  showAlert('meuPerfilSenhaAlert', 'Senha alterada com sucesso!', 'success');
  document.getElementById('senhaAtual').value = '';
  document.getElementById('senhaNova').value = '';
  document.getElementById('senhaConfirmar').value = '';
}
