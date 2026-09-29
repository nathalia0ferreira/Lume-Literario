// ============================================================
//  Lume Literário — API (Supabase Edge Function)
//  Camada de back-end: o navegador NUNCA fala direto com o banco.
//  - Valida a sessão do usuário (Supabase Auth) em toda chamada.
//  - Usa a chave de SERVIÇO no servidor (nunca exposta ao cliente).
//  - Centraliza TODAS as regras de negócio (fonte única).
//  - RBAC: admin / bibliotecario / consulta (consulta é somente leitura).
//  - Registra auditoria das escritas (log_auditoria) e erros (log_erro).
//  Banco em produção: schema snake_case + PKs UUID (padrão oficial após migration 20260613020000).
//  As views vw_*_lista expõem as colunas diretamente, sem aliases de compatibilidade.
//  Protocolo: POST { action, payload } -> { data?, error?, count?, ok?, message? }
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

// Resultado das consultas de detalhe com relacionamentos aninhados. Sem os tipos
// gerados do banco, o supabase-js não infere a forma desses selects, então o
// tipo é declarado explicitamente (relações N:1 chegam como objeto, 1:N como lista).
// deno-lint-ignore no-explicit-any
type LinhaDetalhe = Record<string, any>;

// CORS_ORIGIN é um secret do projeto Supabase (Edge Functions → Secrets), não algo
// que o código consiga aplicar sozinho. Sem ele, o fallback "*" mantém a função
// funcionando (a sessão/RBAC ainda protegem o acesso), mas loga um aviso visível
// em Edge Functions → Logs para não passar despercebido (Achado 9 da auditoria
// 13/07/2026; procedimento de configuração em OPERATIONS.md, item SEG-3).
const CORS_ORIGIN = Deno.env.get('CORS_ORIGIN');
if (!CORS_ORIGIN) {
  console.warn('CORS_ORIGIN não definido — liberando qualquer origem (*). Ver OPERATIONS.md, SEG-3.');
}
const CORS = {
  'Access-Control-Allow-Origin': CORS_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const q = (r: any) =>
  reply({ data: r.data ?? null, error: r.error ? { message: r.error.message } : null, count: r.count ?? null });

// ---- Paginação no servidor via RPC buscar_pagina (Achado 25 — busca fuzzy,
// tolerante a acento/maiúsculas/erro de digitação, ordenada por relevância).
// Substitui o antigo ILIKE('busca', `%termo%`): toda a inteligência de
// comparação (normalização, multi-palavra, fuzzy via pg_trgm, ranking) vive
// na função do banco (normalizar_busca/busca_relevancia/buscar_pagina — ver
// supabase/migrations/20260714220000_busca_fuzzy_unaccent.sql). Aqui só
// repassamos o termo digitado e os filtros que cada tela já tinha. ----
// intArg/limparBusca: cópia da Edge Function (Deno). Algoritmo canônico e
// testado: shared/regras.mjs (ver tests/paginacao.test.mjs).
const intArg = (v: any, def: number, max = Number.MAX_SAFE_INTEGER) => {
  const n = parseInt(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
};
// remove curingas do LIKE para evitar busca imprevisível/injeção de padrão
const limparBusca = (s: any) =>
  String(s ?? '')
    .trim()
    .replace(/[%_\\]/g, ' ');

type OrdemCol = { col: string; asc: boolean };
async function buscarPagina(
  sb: any,
  view: string,
  p: any,
  ordem: OrdemCol | [OrdemCol, OrdemCol],
  filtros: { eq?: Record<string, any>; lte?: Record<string, any>; gte?: Record<string, any> } = {},
) {
  const pageSize = intArg(p.pageSize, 20, 100);
  const page = intArg(p.page, 1);
  const termo = limparBusca(p.q);
  const [ordem1, ordem2] = Array.isArray(ordem) ? ordem : [ordem, undefined];
  const { data, error } = await sb.rpc('buscar_pagina', {
    p_view: view,
    p_termo: termo,
    p_page: page,
    p_page_size: pageSize,
    p_order_col: ordem1?.col ?? null,
    p_order_asc: ordem1?.asc ?? true,
    p_order_col2: ordem2?.col ?? null,
    p_order2_asc: ordem2?.asc ?? true,
    p_filtro_eq: filtros.eq ?? {},
    p_filtro_lte: filtros.lte ?? {},
    p_filtro_gte: filtros.gte ?? {},
  });
  if (error) return reply({ data: null, error: { message: error.message }, count: null });
  const linhas = (data || []).map((r: any) => r.linha);
  const total = data && data.length ? Number(data[0].total) : 0;
  return reply({ data: linhas, error: null, count: total });
}

// ---- RBAC: papéis e quais ações cada um pode executar ----
const PAPEIS = ['admin', 'bibliotecario', 'consulta'];
const ACOES_ESCRITA = new Set([
  'usuarioCriar',
  'usuarioAtualizar',
  'usuarioInativar',
  'usuarioReativar',
  'livroCriar',
  'livroAtualizar',
  'livroExcluir',
  'categoriaCriar',
  'editoraCriar',
  'autorCriar',
  'exemplarCriar',
  'exemplarAtualizarStatus',
  'exemplarExcluir',
  'emprestimoCriar',
  'emprestimoDevolver',
  'reservaCriar',
  'reservaAtualizarStatus',
  'multaPagar',
]);
const ACOES_ADMIN = new Set(['perfisListar', 'perfilDefinir', 'perfilRemover', 'perfilReenviarConvite']);
// Auditoria expõe e-mails de equipe e histórico detalhado de alterações —
// disponível para admin/bibliotecario, oculta para o papel 'consulta'
// (mesmo espírito de ACOES_ADMIN, mas sem restringir a admin apenas).
const ACOES_STAFF_APENAS = new Set(['auditoriaPagina', 'auditoriaUsuarios']);

// Resolve o papel do usuário logado; vincula o bootstrap por e-mail no 1º login
// e auto-provisiona como 'consulta' (menor privilégio) quem ainda não tem perfil.
async function papelDoUsuario(sb: any, user: any): Promise<string> {
  const porId = await sb.from('app_perfil').select('papel').eq('user_id', user.id).maybeSingle();
  if (porId.data?.papel) return porId.data.papel;
  if (user.email) {
    const porEmail = await sb
      .from('app_perfil')
      .select('id,papel')
      .eq('email', user.email)
      .is('user_id', null)
      .maybeSingle();
    if (porEmail.data) {
      await sb.from('app_perfil').update({ user_id: user.id }).eq('id', porEmail.data.id);
      return porEmail.data.papel;
    }
  }
  await sb.from('app_perfil').insert({ user_id: user.id, email: user.email, papel: 'consulta' });
  return 'consulta';
}

// Cópia da Edge Function (Deno; import relativo para fora de
// supabase/functions/ não é garantido no bundle do deploy).
// Algoritmo canônico e testado: shared/regras.mjs. Replicada também
// em js/util.js (browser).
function validarCPF(cpf: string): boolean {
  cpf = (cpf || '').replace(/\D/g, '');
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += parseInt(cpf[i]) * (10 - i);
  let r = (s * 10) % 11;
  if (r >= 10) r = 0;
  if (r !== parseInt(cpf[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += parseInt(cpf[i]) * (11 - i);
  r = (s * 10) % 11;
  if (r >= 10) r = 0;
  return r === parseInt(cpf[10]);
}
const todayStr = () => new Date().toISOString().split('T')[0];
// Diferença em dias entre duas datas "YYYY-MM-DD" (usada na timeline do leitor).
const diffDias = (menor: string, maior: string): number =>
  Math.round((new Date(maior + 'T00:00:00Z').getTime() - new Date(menor + 'T00:00:00Z').getTime()) / 86400000);

const handler = async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: { message: 'Método não suportado.' } }, 405);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  // ---- Autenticação: exige um usuário logado de verdade ----
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const {
    data: { user },
  } = await sb.auth.getUser(token);
  if (!user) return reply({ error: { message: 'Sessão inválida ou expirada. Faça login novamente.' } }, 401);

  // ---- RBAC: papel do usuário (admin / bibliotecario / consulta) ----
  const papel = await papelDoUsuario(sb, user);

  // ---- Auditoria: registra operações de escrita ----
  const logar = async (acao: string, entidade: string, registro_id: any = null, detalhe: any = null) => {
    try {
      await sb.from('log_auditoria').insert({
        usuario_email: user.email,
        acao,
        entidade,
        registro_id: registro_id != null ? String(registro_id) : null,
        detalhe: detalhe ?? null,
      });
    } catch (_) {
      /* auditoria nunca quebra a operação */
    }
  };

  let action = '',
    p: any = {};
  try {
    const body = await req.json();
    action = body.action;
    p = body.payload || {};
  } catch {
    return reply({ error: { message: 'Requisição inválida.' } }, 400);
  }

  try {
    // ---- RBAC enforcement: consulta é somente leitura; ações admin exigem admin ----
    if (ACOES_ESCRITA.has(action) && papel === 'consulta')
      return reply({ ok: false, message: 'Seu perfil (consulta) é somente leitura. Operação não permitida.' }, 403);
    if (ACOES_ADMIN.has(action) && papel !== 'admin')
      return reply({ ok: false, message: 'Apenas administradores podem executar esta operação.' }, 403);
    if (ACOES_STAFF_APENAS.has(action) && papel === 'consulta')
      return reply({ ok: false, message: 'Apenas administradores e bibliotecários podem acessar a auditoria.' }, 403);

    switch (action) {
      // ───────── LEITURAS ─────────
      // Listas: paginadas + busca no servidor via views com alias snake_case
      case 'usuariosPagina': {
        const orderCol = p.sort === 'recentes' ? 'usuario_id' : 'nome';
        const orderAsc = p.sort !== 'recentes';
        const filtroEq: Record<string, any> = {};
        if (p.status === 'ativo') filtroEq.ativo = true;
        if (p.status === 'inativo') filtroEq.ativo = false;
        return await buscarPagina(sb, 'vw_usuarios_lista', p, { col: orderCol, asc: orderAsc }, { eq: filtroEq });
      }
      case 'usuariosStats': {
        const [all, ativos, inativos, emprestimosAbertos, multasAbertas] = await Promise.all([
          sb.from('usuario').select('*', { count: 'exact', head: true }),
          sb.from('usuario').select('*', { count: 'exact', head: true }).eq('ativo', true),
          sb.from('usuario').select('*', { count: 'exact', head: true }).eq('ativo', false),
          sb.from('emprestimo').select('usuario_id').is('data_devolucao', null),
          sb.from('multa').select('emprestimo:emprestimo_id(usuario_id)').eq('pago', false),
        ]);
        // count(distinct usuario_id) não tem atalho no client do PostgREST —
        // dedupe em memória (volume pequeno: no máximo o total de leitores).
        const comEmprestimosAtivos = new Set((emprestimosAbertos.data || []).map((r: any) => r.usuario_id)).size;
        const comMultasPendentes = new Set(
          (multasAbertas.data || []).map((r: any) => r.emprestimo?.usuario_id).filter(Boolean),
        ).size;
        return reply({
          data: {
            total: all.count ?? 0,
            ativos: ativos.count ?? 0,
            inativos: inativos.count ?? 0,
            comEmprestimosAtivos,
            comMultasPendentes,
          },
          error: null,
        });
      }
      // Resumo rápido da tela de Reservas (17/07/2026, feedback de design):
      // reservas ativas, atendidas e o livro com mais reservas ativas agora
      // (indicador de demanda represada). Sem view/RPC nova — segue o mesmo
      // padrão leve de usuariosStats (contagens diretas + agregação em
      // memória, volume pequeno o suficiente numa biblioteca).
      case 'reservasStats': {
        const [{ count: ativas, error: e1 }, { count: atendidas, error: e2 }, { data: ativasRows, error: e3 }] =
          await Promise.all([
            sb.from('reserva').select('reserva_id', { count: 'exact', head: true }).eq('status', 'Ativa'),
            sb.from('reserva').select('reserva_id', { count: 'exact', head: true }).eq('status', 'Atendida'),
            sb.from('reserva').select('livro:livro_id(titulo)').eq('status', 'Ativa'),
          ]);
        if (e1 || e2 || e3) return reply({ ok: false, message: 'Erro ao calcular estatísticas de reservas.' });
        const contagem: Record<string, number> = {};
        for (const r of (ativasRows || []) as any[]) {
          const titulo = r.livro?.titulo;
          if (titulo) contagem[titulo] = (contagem[titulo] || 0) + 1;
        }
        let livroMaisReservado: { titulo: string; total: number } | null = null;
        for (const [titulo, total] of Object.entries(contagem)) {
          if (!livroMaisReservado || total > livroMaisReservado.total) livroMaisReservado = { titulo, total };
        }
        return reply({
          data: { ativas: ativas ?? 0, atendidas: atendidas ?? 0, livroMaisReservado },
          error: null,
        });
      }

      case 'livrosPagina':
        return await buscarPagina(sb, 'vw_livros_lista', p, { col: 'titulo', asc: true });
      case 'exemplaresPagina': {
        // Filtros por status/livro adicionados em 16/07/2026 (reforma da tela
        // de Exemplares) — mesmo padrão de emprestimosPagina. Filtro por
        // leitor adicionado em 17/07/2026 (feedback: "quais livros a Carla
        // está com") — usuario_id vem de vw_exemplares_lista (o leitor com o
        // exemplar emprestado no momento; null quando não está emprestado).
        const filtroEq: Record<string, any> = {};
        if (p.status) filtroEq.status = p.status;
        if (p.livro_id) filtroEq.livro_id = p.livro_id;
        if (p.usuario_id) filtroEq.usuario_id = p.usuario_id;
        return await buscarPagina(
          sb,
          'vw_exemplares_lista',
          p,
          { col: 'codigo_patrimonial', asc: true },
          { eq: filtroEq },
        );
      }
      case 'emprestimosPagina': {
        // Redesenho da tela de Empréstimos (14/07/2026): além de busca livre,
        // aceita filtros server-side por status/leitor/livro/vencimento — mais
        // correto que filtrar em memória só a página já trazida do servidor.
        // Busca livre migrada para buscar_pagina() (Achado 25 — fuzzy/acento).
        const filtroEq: Record<string, any> = {};
        const filtroLte: Record<string, any> = {};
        if (p.status === 'Ativo' || p.status === 'Atrasado' || p.status === 'Devolvido') filtroEq.situacao = p.status;
        if (p.usuario_id) filtroEq.usuario_id = p.usuario_id;
        if (p.livro_id) filtroEq.livro_id = p.livro_id;
        // Filtro Vencimento reformulado (19/07/2026, feedback de design): antes
        // só tinha "vence em até 3 dias"/"atrasados" — passou a espelhar o
        // vocabulário operacional do bibliotecário (Hoje/Esta semana/Atrasados).
        if (p.vencimento === 'hoje') {
          filtroEq.situacao = 'Ativo';
          filtroEq.dias_restantes = 0;
        }
        if (p.vencimento === 'semana') {
          filtroEq.situacao = 'Ativo';
          filtroLte.dias_restantes = 7;
        }
        if (p.vencimento === 'atrasados') filtroEq.situacao = 'Atrasado';
        return await buscarPagina(
          sb,
          'vw_emprestimos_lista',
          p,
          { col: 'emprestimo_id', asc: false },
          { eq: filtroEq, lte: filtroLte },
        );
      }
      case 'reservasPagina': {
        // Filtro por status (18/07/2026, feedback de design) — permite que os
        // cartões de KPI da tela ("Reservas ativas"/"Atendidas") sejam
        // clicáveis e filtrem a tabela, mesmo padrão de emprestimosPagina.
        const filtroEq: Record<string, any> = {};
        if (p.status === 'Ativa' || p.status === 'Atendida' || p.status === 'Cancelada') filtroEq.status = p.status;
        return await buscarPagina(
          sb,
          'vw_reservas_lista',
          p,
          [
            { col: 'data_reserva', asc: true },
            { col: 'reserva_id', asc: true },
          ],
          { eq: filtroEq },
        );
      }
      case 'multasPagina':
        return await buscarPagina(sb, 'vw_multas_lista', p, { col: 'multa_id', asc: false });

      // Auditoria — histórico completo de ações (log_auditoria), separado do
      // Painel Geral (16/07/2026). Reaproveita buscar_pagina() e a view
      // vw_log_auditoria_lista (ver migration 20260716000000). Restrita a
      // admin/bibliotecario — ver ACOES_STAFF_APENAS.
      case 'auditoriaPagina': {
        const filtroEq: Record<string, any> = {};
        const filtroGte: Record<string, any> = {};
        const filtroLte: Record<string, any> = {};
        if (p.usuario) filtroEq.usuario_email = p.usuario;
        if (p.acao) filtroEq.acao = p.acao;
        if (p.entidade) filtroEq.entidade = p.entidade;
        // Período: o front já resolve "Hoje/Esta semana/Este mês/Personalizado"
        // em datas de/até (strings ISO) — aqui só repassamos como gte/lte.
        if (p.de) filtroGte.criado_em = p.de;
        if (p.ate) filtroLte.criado_em = p.ate;
        return await buscarPagina(
          sb,
          'vw_log_auditoria_lista',
          p,
          { col: 'id', asc: false },
          { eq: filtroEq, gte: filtroGte, lte: filtroLte },
        );
      }
      // Lista de usuários (e-mails) distintos com ao menos um registro de
      // auditoria — alimenta o filtro "Usuário" da página de Auditoria.
      case 'auditoriaUsuarios': {
        const { data, error } = await sb
          .from('log_auditoria')
          .select('usuario_email')
          .not('usuario_email', 'is', null)
          .order('usuario_email');
        if (error) return reply({ data: null, error: { message: error.message } });
        const emails = Array.from(new Set((data || []).map((r: any) => r.usuario_email))).sort();
        return reply({ data: emails, error: null });
      }

      // Selects diretos nas tabelas — usam nomes reais do banco (snake_case + UUID)
      case 'usuariosAtivosBasico':
        return q(await sb.from('usuario').select('usuario_id, nome').eq('ativo', true).order('nome'));
      case 'usuarioObter':
        return q(
          await sb
            .from('usuario')
            .select('usuario_id, nome, email, cpf, telefone, ativo')
            .eq('usuario_id', p.id)
            .single(),
        );
      case 'usuarioDetalhe': {
        // "Central do Leitor": dados cadastrais + resumo rápido + linha do
        // tempo unificada (empréstimos, devoluções, reservas, multas e
        // alterações de cadastro), mais recente primeiro. Pedido do
        // responsável pelo projeto em 14/07/2026.
        const { data: leitor, error: eu } = await sb
          .from('usuario')
          .select('usuario_id, nome, email, cpf, telefone, ativo, data_cadastro')
          .eq('usuario_id', p.id)
          .maybeSingle();
        if (eu) return reply({ ok: false, message: 'Erro ao carregar leitor: ' + eu.message });
        if (!leitor) return reply({ ok: false, message: 'Leitor não encontrado.' });

        const [{ data: emprestimosRaw, error: ee }, { data: reservasRaw, error: er }] = await Promise.all([
          sb
            .from('emprestimo')
            .select(
              'emprestimo_id, data_retirada, data_prevista, data_devolucao, ' +
                'exemplar:exemplar_id(codigo_patrimonial, livro:livro_id(livro_id, titulo)), ' +
                'multa(multa_id, valor_dia, dias_atraso, valor_total, pago, data_pagamento, created_at)',
            )
            .eq('usuario_id', p.id)
            .order('data_retirada', { ascending: false }),
          sb
            .from('reserva')
            .select('reserva_id, data_reserva, status, livro:livro_id(livro_id, titulo)')
            .eq('usuario_id', p.id)
            .order('data_reserva', { ascending: false }),
        ]);
        if (ee) return reply({ ok: false, message: 'Erro ao carregar empréstimos: ' + ee.message });
        if (er) return reply({ ok: false, message: 'Erro ao carregar reservas: ' + er.message });

        const emprestimos = (emprestimosRaw || []) as any[];
        const reservas = (reservasRaw || []) as any[];

        // Posição na fila das reservas ainda ativas (mesma regra de vw_reservas_lista:
        // ordem de chegada entre as reservas ativas do mesmo livro).
        const livrosComFila = [
          ...new Set(reservas.filter((r) => r.status === 'Ativa' && r.livro?.livro_id).map((r) => r.livro.livro_id)),
        ] as string[];
        const filaPorReserva: Record<string, number> = {};
        if (livrosComFila.length) {
          const { data: filaRows } = await sb
            .from('reserva')
            .select('reserva_id, livro_id, data_reserva')
            .eq('status', 'Ativa')
            .in('livro_id', livrosComFila)
            .order('data_reserva')
            .order('reserva_id');
          for (const lid of livrosComFila) {
            (filaRows || [])
              .filter((r: any) => r.livro_id === lid)
              .forEach((r: any, idx: number) => {
                filaPorReserva[r.reserva_id] = idx + 1;
              });
          }
        }

        // Auditoria em lote: "funcionário responsável" e diffs de cadastro
        // para cada evento, buscados de uma vez (evita 1 consulta por evento).
        const idsMulta = emprestimos.flatMap((e) => (e.multa || []).map((m: any) => m.multa_id));
        const todosIds = [
          leitor.usuario_id,
          ...emprestimos.map((e) => e.emprestimo_id),
          ...reservas.map((r) => r.reserva_id),
          ...idsMulta,
        ].map(String);
        const { data: logs } = await sb
          .from('log_auditoria')
          .select('acao, entidade, registro_id, usuario_email, criado_em, detalhe')
          .in('registro_id', todosIds)
          .order('criado_em');
        const logsPorChave: Record<string, any[]> = {};
        for (const l of logs || []) {
          const chave = `${l.entidade}:${l.registro_id}:${l.acao}`;
          (logsPorChave[chave] ||= []).push(l);
        }
        const primeiroLog = (ent: string, id: any, acao: string) => logsPorChave[`${ent}:${id}:${acao}`]?.[0] ?? null;
        const ultimoLog = (ent: string, id: any, acao: string) => {
          const arr = logsPorChave[`${ent}:${id}:${acao}`];
          return arr && arr.length ? arr[arr.length - 1] : null;
        };

        const eventos: any[] = [];
        const hoje = todayStr();

        for (const e of emprestimos) {
          const livro = e.exemplar?.livro?.titulo ?? null;
          const codigo = e.exemplar?.codigo_patrimonial ?? null;
          const multa = (e.multa && e.multa[0]) || null;
          const diasAtraso = e.data_devolucao
            ? Math.max(0, diffDias(e.data_prevista, e.data_devolucao))
            : hoje > e.data_prevista
              ? diffDias(e.data_prevista, hoje)
              : 0;
          const logCriar = primeiroLog('emprestimo', e.emprestimo_id, 'emprestimo.criar');
          const logDevolver = e.data_devolucao ? ultimoLog('emprestimo', e.emprestimo_id, 'emprestimo.devolver') : null;

          eventos.push({
            tipo: 'emprestimo',
            quando: logCriar?.criado_em || `${e.data_retirada}T00:00:00Z`,
            livro,
            exemplar: codigo,
            data_retirada: e.data_retirada,
            data_prevista: e.data_prevista,
            data_devolucao: e.data_devolucao,
            situacao: e.data_devolucao
              ? diasAtraso > 0
                ? 'Devolvido com atraso'
                : 'Devolvido no prazo'
              : hoje > e.data_prevista
                ? 'Atrasado'
                : 'Ativo',
            dias_atraso: diasAtraso,
            multa_valor: multa ? Number(multa.valor_total) : null,
            responsavel: logCriar?.usuario_email || null,
          });

          if (e.data_devolucao) {
            eventos.push({
              tipo: 'devolucao',
              quando: logDevolver?.criado_em || `${e.data_devolucao}T00:00:00Z`,
              livro,
              exemplar: codigo,
              data_devolucao: e.data_devolucao,
              dias_atraso: diasAtraso,
              multa_valor: multa ? Number(multa.valor_total) : null,
              responsavel: logDevolver?.usuario_email || null,
            });
          }

          if (multa) {
            const criadoEm =
              multa.created_at || logDevolver?.criado_em || `${e.data_devolucao || e.data_prevista}T00:00:00Z`;
            eventos.push({
              tipo: 'multa',
              quando: criadoEm,
              livro,
              motivo: 'Atraso na devolução do exemplar',
              valor: Number(multa.valor_total),
              data_geracao: criadoEm,
              data_pagamento: multa.data_pagamento,
              status: multa.pago ? 'Pago' : 'Pendente',
              responsavel: logDevolver?.usuario_email || null,
            });
            if (multa.pago) {
              const logPagar = ultimoLog('multa', multa.multa_id, 'multa.pagar');
              eventos.push({
                tipo: 'multa_paga',
                quando: logPagar?.criado_em || multa.data_pagamento || criadoEm,
                livro,
                valor: Number(multa.valor_total),
                data_pagamento: multa.data_pagamento,
                responsavel: logPagar?.usuario_email || null,
              });
            }
          }
        }

        for (const r of reservas) {
          const livro = r.livro?.titulo ?? null;
          const logCriar = primeiroLog('reserva', r.reserva_id, 'reserva.criar');
          eventos.push({
            tipo: 'reserva',
            quando: logCriar?.criado_em || `${r.data_reserva}T00:00:00Z`,
            livro,
            data_reserva: r.data_reserva,
            status: r.status,
            fila: r.status === 'Ativa' ? (filaPorReserva[r.reserva_id] ?? null) : null,
            responsavel: logCriar?.usuario_email || null,
          });
          if (r.status !== 'Ativa') {
            const logStatus = ultimoLog('reserva', r.reserva_id, 'reserva.status');
            eventos.push({
              tipo: r.status === 'Atendida' ? 'reserva_atendida' : 'reserva_cancelada',
              quando: logStatus?.criado_em || `${r.data_reserva}T00:00:00Z`,
              livro,
              data_reserva: r.data_reserva,
              status: r.status,
              responsavel: logStatus?.usuario_email || null,
            });
          }
        }

        const ACAO_CADASTRO: Record<string, string> = {
          'usuario.criar': 'Cadastro criado',
          'usuario.atualizar': 'Cadastro atualizado',
          'usuario.inativar': 'Leitor inativado',
          'usuario.reativar': 'Leitor reativado',
        };
        for (const l of logs || []) {
          if (l.entidade !== 'usuario' || l.registro_id !== leitor.usuario_id) continue;
          eventos.push({
            tipo: 'cadastro',
            subtipo: l.acao,
            quando: l.criado_em,
            titulo: ACAO_CADASTRO[l.acao] || l.acao,
            alteracoes: l.detalhe?.alteracoes || null,
            responsavel: l.usuario_email || null,
          });
        }

        eventos.sort((a, b) => new Date(b.quando).getTime() - new Date(a.quando).getTime());

        return reply({
          data: {
            ...leitor,
            resumo: {
              emprestimosAtivos: emprestimos.filter((e) => !e.data_devolucao).length,
              reservasAtivas: reservas.filter((r) => r.status === 'Ativa').length,
              multasPendentes: emprestimos.filter((e) => e.multa?.[0] && !e.multa[0].pago).length,
            },
            eventos,
          },
          error: null,
        });
      }

      case 'emprestimoDetalhe': {
        // Painel de detalhes do empréstimo (redesenho da tela de Empréstimos,
        // 14/07/2026): dados completos + linha do tempo curta (registro →
        // prazo/devolução → multa), nos mesmos moldes de usuarioDetalhe.
        const { data: emp, error: ee } = await sb
          .from('emprestimo')
          .select(
            'emprestimo_id, usuario_id, exemplar_id, data_retirada, data_prevista, data_devolucao, ' +
              'usuario:usuario_id(usuario_id, nome), ' +
              'exemplar:exemplar_id(exemplar_id, codigo_patrimonial, livro:livro_id(livro_id, titulo, livro_autor(autor:autor_id(nome_autor)))), ' +
              'multa(multa_id, valor_dia, dias_atraso, valor_total, pago, data_pagamento, created_at)',
          )
          .eq('emprestimo_id', p.id)
          .maybeSingle<LinhaDetalhe>();
        if (ee) return reply({ ok: false, message: 'Erro ao carregar empréstimo: ' + ee.message });
        if (!emp) return reply({ ok: false, message: 'Empréstimo não encontrado.' });

        const hoje = todayStr();
        const multa = (emp.multa && emp.multa[0]) || null;
        const diasAtraso = emp.data_devolucao
          ? Math.max(0, diffDias(emp.data_prevista, emp.data_devolucao))
          : hoje > emp.data_prevista
            ? diffDias(emp.data_prevista, hoje)
            : 0;
        const situacao = emp.data_devolucao
          ? diasAtraso > 0
            ? 'Devolvido com atraso'
            : 'Devolvido no prazo'
          : hoje > emp.data_prevista
            ? 'Atrasado'
            : 'Ativo';

        // Multa prevista (empréstimo ainda aberto e já atrasado): mesma conta
        // que o procedimento registrar_devolucao() vai cobrar de fato — usada
        // só como prévia no modal de devolução, nunca como valor gravado.
        let multaPrevista: number | null = null;
        if (!emp.data_devolucao && diasAtraso > 0) {
          const { data: cfg } = await sb
            .from('configuracao')
            .select('valor_numerico')
            .eq('chave', 'valor_dia_multa')
            .maybeSingle();
          const valorDia = Number(cfg?.valor_numerico ?? 2);
          multaPrevista = Math.round(diasAtraso * valorDia * 100) / 100;
        }

        const idsBusca = [emp.emprestimo_id, ...(multa ? [multa.multa_id] : [])].map(String);
        const { data: logs } = await sb
          .from('log_auditoria')
          .select('acao, entidade, registro_id, usuario_email, criado_em')
          .in('registro_id', idsBusca)
          .order('criado_em');
        const acharLog = (ent: string, id: any, acao: string) =>
          (logs || []).find(
            (l: any) => l.entidade === ent && String(l.registro_id) === String(id) && l.acao === acao,
          ) ?? null;
        const logCriar = acharLog('emprestimo', emp.emprestimo_id, 'emprestimo.criar');
        const logDevolver = acharLog('emprestimo', emp.emprestimo_id, 'emprestimo.devolver');
        const logPagar = multa ? acharLog('multa', multa.multa_id, 'multa.pagar') : null;

        // Timeline enxuta (19/07/2026, quarta rodada de feedback — "isso é
        // pouco"): antes havia um marco "Ainda não devolvido" sempre que o
        // empréstimo seguia aberto (mesmo dentro do prazo, sem nada de novo
        // pra contar) e um evento "Multa gerada" separado logo depois de
        // "Livro devolvido" — na prática o mesmo instante contado duas
        // vezes. Agora: só existe marco de "prazo estourou" quando o
        // empréstimo está mesmo atrasado e ainda aberto; o valor da multa
        // (quando existe) vai embutido no próprio evento "Livro devolvido",
        // e só "Multa paga" continua como evento à parte — é o único desses
        // três que pode acontecer bem depois, em outro momento de verdade.
        const eventos: any[] = [
          {
            tipo: 'emprestimo',
            quando: logCriar?.criado_em || `${emp.data_retirada}T00:00:00Z`,
            titulo: 'Empréstimo registrado',
            responsavel: logCriar?.usuario_email ?? null,
          },
        ];
        // Corrigido em 19/07/2026 (sétima rodada de feedback — "eu incluiria
        // um evento intermediário quando houver atraso... isso mostra
        // exatamente quando o empréstimo deixou de estar regular"): antes só
        // aparecia enquanto o empréstimo seguia aberto (!emp.data_devolucao),
        // então um empréstimo devolvido com atraso perdia esse marco por
        // completo assim que era devolvido — a timeline pulava direto de
        // "Empréstimo registrado" para "Livro devolvido", sem mostrar quando
        // o atraso começou. Agora depende só de ter havido atraso de fato
        // (diasAtraso > 0), aberto ou já devolvido.
        if (diasAtraso > 0) {
          // Marco sintético (não vem de log_auditoria — é um cálculo, não um
          // evento gravado): sinaliza quando o prazo estourou.
          eventos.push({
            tipo: 'prazo_expirado',
            quando: `${emp.data_prevista}T00:00:00Z`,
            titulo: 'Prazo de devolução atingido',
            sintetico: true,
          });
        }
        if (emp.data_devolucao) {
          eventos.push({
            tipo: 'devolucao',
            quando: logDevolver?.criado_em || `${emp.data_devolucao}T00:00:00Z`,
            titulo: 'Livro devolvido',
            responsavel: logDevolver?.usuario_email ?? null,
          });
        }
        if (multa && multa.pago) {
          eventos.push({
            tipo: 'multa_paga',
            quando: logPagar?.criado_em || multa.data_pagamento || multa.created_at,
            titulo: 'Multa paga',
            valor: Number(multa.valor_total),
            responsavel: logPagar?.usuario_email ?? null,
          });
        }
        eventos.sort((a, b) => new Date(a.quando).getTime() - new Date(b.quando).getTime());

        return reply({
          data: {
            emprestimo_id: emp.emprestimo_id,
            usuario_id: emp.usuario_id,
            usuario_nome: emp.usuario?.nome ?? null,
            livro_id: emp.exemplar?.livro?.livro_id ?? null,
            livro_titulo: emp.exemplar?.livro?.titulo ?? null,
            autores: (emp.exemplar?.livro?.livro_autor || [])
              .map((la: any) => la.autor?.nome_autor)
              .filter(Boolean)
              .join(', '),
            // exemplar_id (19/07/2026, feedback de design): permite tornar o
            // código do exemplar clicável no modal, levando ao seu próprio
            // Detalhe do Exemplar (mesmo padrão já usado em outras telas).
            exemplar_id: emp.exemplar?.exemplar_id ?? null,
            exemplar_codigo: emp.exemplar?.codigo_patrimonial ?? null,
            data_retirada: emp.data_retirada,
            data_prevista: emp.data_prevista,
            data_devolucao: emp.data_devolucao,
            situacao,
            dias_atraso: diasAtraso,
            multa_valor: multa ? Number(multa.valor_total) : null,
            multa_pago: multa ? multa.pago : null,
            multa_prevista: multaPrevista,
            // responsavel (19/07/2026, feedback de design — bloco "Resumo" no
            // modal): quem processou a ação mais recente que define o estado
            // atual — quem devolveu, se já devolvido; senão quem registrou o
            // empréstimo. Antes essa informação só existia por evento dentro
            // de `eventos`, sem um campo único pronto pro resumo.
            responsavel: (emp.data_devolucao ? logDevolver?.usuario_email : logCriar?.usuario_email) ?? null,
            eventos,
          },
          error: null,
        });
      }

      case 'livroResumoDisponibilidade': {
        // Painel informativo do modal "Novo Empréstimo" (item 13 do pedido de
        // 14/07/2026): quantos exemplares do livro escolhido estão
        // disponíveis/emprestados e quantas reservas ativas existem para ele.
        // 18/07/2026, feedback de design ("minha maior sugestão" da rodada):
        // passou a trazer também proximaDevolucao (data prevista mais próxima
        // entre os empréstimos abertos do livro — só faz sentido mostrar
        // quando não há exemplar disponível agora) e fila (lista ordenada das
        // reservas ativas) — usado tanto no formulário "Nova Reserva" ("Fila
        // atual" ao escolher o livro, evita reserva duplicada) quanto no novo
        // modal de Detalhes da Reserva ("Fila completa").
        const livroId = p.livro_id;
        if (!livroId) return reply({ ok: false, message: 'Livro não informado.' });
        const [
          { count: disponiveis, error: e1 },
          { data: exemplaresEmprestadosRows, error: e2 },
          { data: filaRows, error: e3 },
        ] = await Promise.all([
          sb
            .from('exemplar')
            .select('exemplar_id', { count: 'exact', head: true })
            .eq('livro_id', livroId)
            .eq('status', 'Disponivel'),
          sb.from('exemplar').select('exemplar_id').eq('livro_id', livroId).eq('status', 'Emprestado'),
          sb
            .from('reserva')
            .select('reserva_id, usuario:usuario_id(nome), data_reserva')
            .eq('livro_id', livroId)
            .eq('status', 'Ativa')
            .order('data_reserva')
            .order('reserva_id'),
        ]);
        if (e1 || e2 || e3) return reply({ ok: false, message: 'Erro ao consultar disponibilidade.' });
        const exemplaresEmprestadosIds = (exemplaresEmprestadosRows || []).map((e: any) => e.exemplar_id);
        // Próxima devolução prevista (18/07/2026, feedback de design) — só
        // relevante quando não há exemplar disponível agora, mesmo padrão de
        // duas etapas já usado em livroDetalhe (busca os exemplares do livro,
        // depois os empréstimos abertos desses exemplares).
        let proximaDevolucao: string | null = null;
        if (exemplaresEmprestadosIds.length) {
          const { data: abertos, error: e4 } = await sb
            .from('emprestimo')
            .select('data_prevista')
            .in('exemplar_id', exemplaresEmprestadosIds)
            .is('data_devolucao', null)
            .order('data_prevista')
            .limit(1);
          if (e4) return reply({ ok: false, message: 'Erro ao consultar previsão de devolução.' });
          proximaDevolucao = abertos?.[0]?.data_prevista ?? null;
        }
        const fila = (filaRows || []).map((r: any) => ({
          reserva_id: r.reserva_id,
          usuario_nome: r.usuario?.nome ?? null,
          data_reserva: r.data_reserva,
        }));
        return reply({
          data: {
            disponiveis: disponiveis ?? 0,
            emprestados: exemplaresEmprestadosIds.length,
            reservas: fila.length,
            proximaDevolucao,
            fila,
          },
          error: null,
        });
      }

      case 'livrosBasico':
        return q(await sb.from('livro').select('livro_id, titulo').order('titulo'));
      case 'livroParaEdicao':
        return q(
          await sb
            .from('livro')
            .select('livro_id, titulo, isbn, ano_publicacao, categoria_id, editora_id, livro_autor(autor_id)')
            .eq('livro_id', p.id)
            .single(),
        );

      case 'livroDetalhe': {
        // "Perfil do Livro" (redesenho da tela de Livros, 14/07/2026): dados
        // bibliográficos + estatísticas + lista de exemplares (com leitor e
        // previsão de devolução quando emprestado) + reservas ativas (com
        // posição na fila) + linha do tempo unificada (livro cadastrado,
        // exemplar cadastrado, empréstimo/devolução, reserva criada/atendida/
        // cancelada), nos mesmos moldes de usuarioDetalhe/emprestimoDetalhe.
        // Também serve o modal "Gerenciar Exemplares" (reaproveita `exemplares`).
        const { data: livro, error: el } = await sb
          .from('livro')
          .select(
            'livro_id, titulo, isbn, ano_publicacao, created_at, ' +
              'categoria:categoria_id(nome_categoria), editora:editora_id(nome_editora), ' +
              'livro_autor(autor:autor_id(nome_autor))',
          )
          .eq('livro_id', p.id)
          .maybeSingle<LinhaDetalhe>();
        if (el) return reply({ ok: false, message: 'Erro ao carregar livro: ' + el.message });
        if (!livro) return reply({ ok: false, message: 'Livro não encontrado.' });

        const { data: exemplaresRaw, error: eex } = await sb
          .from('exemplar')
          .select('exemplar_id, codigo_patrimonial, status, motivo_baixa, created_at, updated_at')
          .eq('livro_id', p.id)
          .order('codigo_patrimonial');
        if (eex) return reply({ ok: false, message: 'Erro ao carregar exemplares: ' + eex.message });
        const exemplares = (exemplaresRaw || []) as any[];
        const exemplarIds = exemplares.map((e) => e.exemplar_id);

        const { data: emprestimosRaw, error: ee } = exemplarIds.length
          ? await sb
              .from('emprestimo')
              .select(
                'emprestimo_id, exemplar_id, data_retirada, data_prevista, data_devolucao, usuario:usuario_id(nome)',
              )
              .in('exemplar_id', exemplarIds)
              .order('data_retirada', { ascending: false })
          : { data: [] as any[], error: null };
        if (ee) return reply({ ok: false, message: 'Erro ao carregar empréstimos: ' + ee.message });
        const emprestimos = (emprestimosRaw || []) as any[];

        const { data: reservasRaw, error: er } = await sb
          .from('reserva')
          .select('reserva_id, usuario:usuario_id(nome), data_reserva, status')
          .eq('livro_id', p.id)
          .order('data_reserva')
          .order('reserva_id');
        if (er) return reply({ ok: false, message: 'Erro ao carregar reservas: ' + er.message });
        const reservas = (reservasRaw || []) as any[];

        // Posição na fila só entre as reservas ainda ativas (mesmo critério de vw_reservas_lista),
        // mas aqui já filtrado a um único livro, então basta um índice sequencial.
        let filaSeq = 0;
        const filaPorReserva: Record<string, number> = {};
        for (const r of reservas) {
          if (r.status === 'Ativa') filaPorReserva[r.reserva_id] = ++filaSeq;
        }

        // Auditoria em lote (mesmo padrão de usuarioDetalhe/emprestimoDetalhe).
        const todosIds = [
          livro.livro_id,
          ...exemplarIds,
          ...emprestimos.map((e) => e.emprestimo_id),
          ...reservas.map((r) => r.reserva_id),
        ].map(String);
        const { data: logs } = await sb
          .from('log_auditoria')
          .select('acao, entidade, registro_id, usuario_email, criado_em')
          .in('registro_id', todosIds)
          .order('criado_em');
        const logsPorChave: Record<string, any[]> = {};
        for (const l of logs || []) {
          const chave = `${l.entidade}:${l.registro_id}:${l.acao}`;
          (logsPorChave[chave] ||= []).push(l);
        }
        const primeiroLog = (ent: string, id: any, acao: string) => logsPorChave[`${ent}:${id}:${acao}`]?.[0] ?? null;
        const ultimoLog = (ent: string, id: any, acao: string) => {
          const arr = logsPorChave[`${ent}:${id}:${acao}`];
          return arr && arr.length ? arr[arr.length - 1] : null;
        };

        const hoje = todayStr();
        const eventos: any[] = [];

        const logLivroCriar = primeiroLog('livro', livro.livro_id, 'livro.criar');
        eventos.push({
          tipo: 'livro_cadastro',
          quando: logLivroCriar?.criado_em || livro.created_at,
          isbn: livro.isbn,
          responsavel: logLivroCriar?.usuario_email || null,
        });

        for (const ex2 of exemplares) {
          const logExCriar = primeiroLog('exemplar', ex2.exemplar_id, 'exemplar.criar');
          eventos.push({
            tipo: 'exemplar_cadastro',
            quando: logExCriar?.criado_em || ex2.created_at,
            exemplar: ex2.codigo_patrimonial,
            responsavel: logExCriar?.usuario_email || null,
          });
        }

        for (const e of emprestimos) {
          const exCod = exemplares.find((x) => x.exemplar_id === e.exemplar_id)?.codigo_patrimonial ?? null;
          const diasAtraso = e.data_devolucao
            ? Math.max(0, diffDias(e.data_prevista, e.data_devolucao))
            : hoje > e.data_prevista
              ? diffDias(e.data_prevista, hoje)
              : 0;
          const logCriar = primeiroLog('emprestimo', e.emprestimo_id, 'emprestimo.criar');
          const logDevolver = e.data_devolucao ? ultimoLog('emprestimo', e.emprestimo_id, 'emprestimo.devolver') : null;
          eventos.push({
            tipo: 'emprestimo',
            quando: logCriar?.criado_em || `${e.data_retirada}T00:00:00Z`,
            livro: livro.titulo,
            usuario_nome: e.usuario?.nome ?? null,
            exemplar: exCod,
            data_retirada: e.data_retirada,
            data_prevista: e.data_prevista,
            data_devolucao: e.data_devolucao,
            situacao: e.data_devolucao
              ? diasAtraso > 0
                ? 'Devolvido com atraso'
                : 'Devolvido no prazo'
              : hoje > e.data_prevista
                ? 'Atrasado'
                : 'Ativo',
            dias_atraso: diasAtraso,
            responsavel: logCriar?.usuario_email || null,
          });
          if (e.data_devolucao) {
            eventos.push({
              tipo: 'devolucao',
              quando: logDevolver?.criado_em || `${e.data_devolucao}T00:00:00Z`,
              livro: livro.titulo,
              usuario_nome: e.usuario?.nome ?? null,
              exemplar: exCod,
              data_devolucao: e.data_devolucao,
              dias_atraso: diasAtraso,
              responsavel: logDevolver?.usuario_email || null,
            });
          }
        }

        for (const r of reservas) {
          const logCriar = primeiroLog('reserva', r.reserva_id, 'reserva.criar');
          eventos.push({
            tipo: 'reserva',
            quando: logCriar?.criado_em || `${r.data_reserva}T00:00:00Z`,
            livro: livro.titulo,
            usuario_nome: r.usuario?.nome ?? null,
            data_reserva: r.data_reserva,
            status: r.status,
            fila: r.status === 'Ativa' ? (filaPorReserva[r.reserva_id] ?? null) : null,
            responsavel: logCriar?.usuario_email || null,
          });
          if (r.status !== 'Ativa') {
            const logStatus = ultimoLog('reserva', r.reserva_id, 'reserva.status');
            eventos.push({
              tipo: r.status === 'Atendida' ? 'reserva_atendida' : 'reserva_cancelada',
              quando: logStatus?.criado_em || `${r.data_reserva}T00:00:00Z`,
              livro: livro.titulo,
              usuario_nome: r.usuario?.nome ?? null,
              status: r.status,
              responsavel: logStatus?.usuario_email || null,
            });
          }
        }

        eventos.sort((a, b) => new Date(b.quando).getTime() - new Date(a.quando).getTime());

        const reservasAtivas = reservas
          .filter((r) => r.status === 'Ativa')
          .map((r) => ({
            reserva_id: r.reserva_id,
            usuario_nome: r.usuario?.nome ?? null,
            data_reserva: r.data_reserva,
            fila: filaPorReserva[r.reserva_id],
          }));

        // motivo_baixa/atrasado/dias_atraso/reservas_ativas (17/07/2026,
        // feedback de design) — mesmos campos que vw_exemplares_lista já
        // calcula para a tela de Exemplares, replicados aqui para que os
        // cards de exemplar do Detalhe do Livro (renderExemplaresCards) e do
        // modal Controle de Exemplares (renderExemplaresGerenciarCards)
        // tenham a mesma informação disponível.
        // updated_at (19/07/2026, oitava rodada de feedback — cards do modal
        // Gerenciar/Controle de Exemplares): mesmo campo que exemplarDetalhe
        // já expõe como "última alteração de status" — faltava aqui para os
        // cards mostrarem "Baixado em {data}"/"Em manutenção desde {data}".
        const exemplaresOut = exemplares.map((ex2) => {
          const ativo = emprestimos.find((e) => e.exemplar_id === ex2.exemplar_id && !e.data_devolucao);
          const atrasado = !!ativo && hoje > ativo.data_prevista;
          return {
            exemplar_id: ex2.exemplar_id,
            codigo_patrimonial: ex2.codigo_patrimonial,
            status: ex2.status,
            motivo_baixa: ex2.motivo_baixa ?? null,
            updated_at: ex2.updated_at ?? null,
            usuario_nome: ativo?.usuario?.nome ?? null,
            data_prevista: ativo?.data_prevista ?? null,
            atrasado,
            dias_atraso: atrasado ? diffDias(ativo.data_prevista, hoje) : null,
            reservas_ativas: reservasAtivas.length,
          };
        });

        return reply({
          data: {
            livro_id: livro.livro_id,
            titulo: livro.titulo,
            isbn: livro.isbn,
            ano_publicacao: livro.ano_publicacao,
            categoria_nome: livro.categoria?.nome_categoria ?? null,
            editora_nome: livro.editora?.nome_editora ?? null,
            autores: (livro.livro_autor || [])
              .map((la: any) => la.autor?.nome_autor)
              .filter(Boolean)
              .join(', '),
            estatisticas: {
              totalExemplares: exemplares.length,
              disponiveis: exemplares.filter((e) => e.status === 'Disponivel').length,
              emprestados: exemplares.filter((e) => e.status === 'Emprestado').length,
              reservasAtivas: reservasAtivas.length,
            },
            exemplares: exemplaresOut,
            reservas: reservasAtivas,
            eventos,
          },
          error: null,
        });
      }

      case 'exemplarDetalhe': {
        // Tela de Detalhe do Exemplar (16/07/2026, reforma da tela de
        // Exemplares): dados do exemplar + histórico completo (cadastro,
        // empréstimos/devoluções desta cópia específica, mudanças de status/
        // motivo de baixa) + reservas ativas do livro (reserva é por livro,
        // não por exemplar — mesmo padrão de livroDetalhe, aqui só para dar
        // contexto de "alguém está esperando este título"). Leitura livre
        // (disponível a qualquer papel, como livroDetalhe/usuarioDetalhe).
        const { data: ex, error: eex } = await sb
          .from('exemplar')
          .select(
            'exemplar_id, codigo_patrimonial, status, motivo_baixa, livro_id, created_at, updated_at, ' +
              'livro:livro_id(titulo, isbn, ano_publicacao, categoria:categoria_id(nome_categoria), editora:editora_id(nome_editora))',
          )
          .eq('exemplar_id', p.id)
          .maybeSingle<LinhaDetalhe>();
        if (eex) return reply({ ok: false, message: 'Erro ao carregar exemplar: ' + eex.message });
        if (!ex) return reply({ ok: false, message: 'Exemplar não encontrado.' });

        const [{ data: emprestimosRaw, error: ee }, { data: reservasRaw, error: er }] = await Promise.all([
          sb
            .from('emprestimo')
            .select('emprestimo_id, data_retirada, data_prevista, data_devolucao, usuario:usuario_id(nome)')
            .eq('exemplar_id', p.id)
            .order('data_retirada', { ascending: false }),
          sb
            .from('reserva')
            .select('reserva_id, usuario:usuario_id(nome), data_reserva, status')
            .eq('livro_id', ex.livro_id)
            .eq('status', 'Ativa')
            .order('data_reserva')
            .order('reserva_id'),
        ]);
        if (ee) return reply({ ok: false, message: 'Erro ao carregar empréstimos: ' + ee.message });
        if (er) return reply({ ok: false, message: 'Erro ao carregar reservas: ' + er.message });
        const emprestimos = (emprestimosRaw || []) as any[];
        const reservasAtivas = (reservasRaw || []) as any[];

        const todosIds = [ex.exemplar_id, ...emprestimos.map((e) => e.emprestimo_id)].map(String);
        const { data: logs } = await sb
          .from('log_auditoria')
          .select('acao, entidade, registro_id, usuario_email, criado_em, detalhe')
          .in('registro_id', todosIds)
          .order('criado_em');
        const logsPorChave: Record<string, any[]> = {};
        for (const l of logs || []) {
          const chave = `${l.entidade}:${l.registro_id}:${l.acao}`;
          (logsPorChave[chave] ||= []).push(l);
        }
        const primeiroLog = (ent: string, id: any, acao: string) => logsPorChave[`${ent}:${id}:${acao}`]?.[0] ?? null;
        const todosLogs = (ent: string, id: any, acao: string) => logsPorChave[`${ent}:${id}:${acao}`] || [];

        const hoje = todayStr();
        const eventos: any[] = [];

        const logCadastro = primeiroLog('exemplar', ex.exemplar_id, 'exemplar.criar');
        eventos.push({
          tipo: 'exemplar_cadastro',
          quando: logCadastro?.criado_em || ex.created_at,
          exemplar: ex.codigo_patrimonial,
          responsavel: logCadastro?.usuario_email || null,
        });

        for (const logStatus of todosLogs('exemplar', ex.exemplar_id, 'exemplar.status')) {
          const alt = (logStatus.detalhe?.alteracoes || []).find((a: any) => a.campo === 'Status');
          const altMotivo = (logStatus.detalhe?.alteracoes || []).find((a: any) => a.campo === 'Motivo da baixa');
          // Fallback para registros antigos de auditoria (19/07/2026, feedback
          // de design: "Status alterado — → —" na timeline): antes do formato
          // {alteracoes:[{campo,de,para}]} existir, exemplar.status gravava só
          // {status: 'X'}, sem o valor anterior. Nesses casos não temos como
          // saber o "de" (não fica gravado em lugar nenhum), mas ainda dá pra
          // mostrar o "para" em vez de deixar os dois lados em branco.
          const paraLegado = !alt ? (logStatus.detalhe?.status ?? null) : null;
          eventos.push({
            tipo: 'status_alterado',
            quando: logStatus.criado_em,
            exemplar: ex.codigo_patrimonial,
            de: alt?.de ?? null,
            para: alt?.para ?? paraLegado,
            motivo: altMotivo?.para ?? null,
            responsavel: logStatus.usuario_email || null,
          });
        }

        for (const e of emprestimos) {
          const diasAtraso = e.data_devolucao
            ? Math.max(0, diffDias(e.data_prevista, e.data_devolucao))
            : hoje > e.data_prevista
              ? diffDias(e.data_prevista, hoje)
              : 0;
          const logCriar = primeiroLog('emprestimo', e.emprestimo_id, 'emprestimo.criar');
          const logsDevolver = todosLogs('emprestimo', e.emprestimo_id, 'emprestimo.devolver');
          const logDevolver = e.data_devolucao ? (logsDevolver[logsDevolver.length - 1] ?? null) : null;
          eventos.push({
            tipo: 'emprestimo',
            quando: logCriar?.criado_em || `${e.data_retirada}T00:00:00Z`,
            livro: ex.livro?.titulo ?? null,
            usuario_nome: e.usuario?.nome ?? null,
            exemplar: ex.codigo_patrimonial,
            data_retirada: e.data_retirada,
            data_prevista: e.data_prevista,
            data_devolucao: e.data_devolucao,
            situacao: e.data_devolucao
              ? diasAtraso > 0
                ? 'Devolvido com atraso'
                : 'Devolvido no prazo'
              : hoje > e.data_prevista
                ? 'Atrasado'
                : 'Ativo',
            dias_atraso: diasAtraso,
            responsavel: logCriar?.usuario_email || null,
          });
          if (e.data_devolucao) {
            eventos.push({
              tipo: 'devolucao',
              quando: logDevolver?.criado_em || `${e.data_devolucao}T00:00:00Z`,
              livro: ex.livro?.titulo ?? null,
              usuario_nome: e.usuario?.nome ?? null,
              exemplar: ex.codigo_patrimonial,
              data_devolucao: e.data_devolucao,
              dias_atraso: diasAtraso,
              responsavel: logDevolver?.usuario_email || null,
            });
          }
        }

        eventos.sort((a, b) => new Date(b.quando).getTime() - new Date(a.quando).getTime());

        const emprestimoAtivo = emprestimos.find((e) => !e.data_devolucao) || null;
        // atrasado/dias_atraso (17/07/2026, feedback de design) — mesmo
        // cálculo de vw_exemplares_lista/livroDetalhe, replicado aqui para
        // que o badge do modal de Detalhe do Exemplar também diferencie
        // "Emprestado" (no prazo) de "Atrasado" (prazo vencido).
        const atrasado = !!emprestimoAtivo && hoje > emprestimoAtivo.data_prevista;

        return reply({
          data: {
            exemplar_id: ex.exemplar_id,
            codigo_patrimonial: ex.codigo_patrimonial,
            status: ex.status,
            motivo_baixa: ex.motivo_baixa,
            livro_id: ex.livro_id,
            livro_titulo: ex.livro?.titulo ?? null,
            livro_isbn: ex.livro?.isbn ?? null,
            livro_ano: ex.livro?.ano_publicacao ?? null,
            livro_categoria: ex.livro?.categoria?.nome_categoria ?? null,
            livro_editora: ex.livro?.editora?.nome_editora ?? null,
            created_at: ex.created_at,
            // updated_at (19/07/2026, feedback de design): único UPDATE que a
            // aplicação faz em `exemplar` é a troca de status
            // (exemplarAtualizarStatus), então esse campo funciona como uma
            // data de "última alteração de status" sem precisar de coluna
            // dedicada — usado para "Baixado em {data}"/"Em manutenção desde
            // {data}" na tabela e no modal de detalhe.
            updated_at: ex.updated_at,
            usuario_nome: emprestimoAtivo?.usuario?.nome ?? null,
            // data_retirada (18/07/2026, feedback de design): o modal de
            // detalhe passou a mostrar Retirada + Prazo + Atraso como campos
            // separados (em vez de um rótulo que alternava entre Prazo e
            // Atraso) — precisa da data de retirada do empréstimo ativo, que
            // já vinha no select de emprestimos mas não saía na resposta.
            data_retirada: emprestimoAtivo?.data_retirada ?? null,
            data_prevista: emprestimoAtivo?.data_prevista ?? null,
            atrasado,
            dias_atraso: atrasado ? diffDias(emprestimoAtivo.data_prevista, hoje) : null,
            totalEmprestimos: emprestimos.length,
            // emprestimo_atual_id/ultimo_emprestimo_id (19/07/2026, sexta
            // rodada de feedback — "integrar navegação Exemplar→Empréstimo"):
            // o modal de Empréstimo já expõe "Ver livro"/"Ver leitor"
            // (Achado 38); aqui é o mesmo padrão na direção contrária, para o
            // bloco "Empréstimo atual" e o "Último uso" das Estatísticas
            // virarem links para abrirDetalhesEmprestimo. `emprestimos` já
            // vem ordenado por data_retirada desc, então o primeiro é sempre
            // o mais recente.
            emprestimo_atual_id: emprestimoAtivo?.emprestimo_id ?? null,
            ultimo_emprestimo_id: emprestimos[0]?.emprestimo_id ?? null,
            reservasAtivasLivro: reservasAtivas.map((r) => ({
              reserva_id: r.reserva_id,
              usuario_nome: r.usuario?.nome ?? null,
              data_reserva: r.data_reserva,
            })),
            reservas_ativas: reservasAtivas.length,
            eventos,
          },
          error: null,
        });
      }

      case 'exemplaresDisponiveis':
        return q(
          await sb
            .from('exemplar')
            .select('exemplar_id, codigo_patrimonial, livro_id, livro(titulo)')
            .eq('status', 'Disponivel')
            .order('codigo_patrimonial'),
        );

      // Preview do próximo código patrimonial (17/07/2026, feedback sobre a
      // tela de Exemplares) — só leitura, não avança a sequence. Usado pelo
      // modal "Novo Exemplar" para mostrar o código previsto antes de
      // confirmar o cadastro, em vez do texto genérico "gerado
      // automaticamente".
      case 'exemplarProximoCodigo': {
        const { data: proximo, error: eprox } = await sb.rpc('proximo_codigo_patrimonial');
        if (eprox) return reply({ data: null, error: { message: eprox.message } });
        return reply({ data: proximo, error: null });
      }

      // Leitores com pelo menos um empréstimo em aberto agora (17/07/2026,
      // feedback de design) — popula o filtro "Leitor" da tela de Exemplares.
      // Lista deliberadamente pequena/escopada (só quem está com algo
      // emprestado), não todos os leitores ativos — mais útil como filtro e
      // evita um <select> gigante numa biblioteca com muitos leitores.
      case 'exemplarLeitoresComEmprestimo': {
        const { data, error } = await sb
          .from('emprestimo')
          .select('usuario:usuario_id(usuario_id, nome)')
          .is('data_devolucao', null);
        if (error) return reply({ data: null, error: { message: error.message } });
        const vistos = new Set<string>();
        const leitores: { usuario_id: string; nome: string }[] = [];
        for (const row of (data || []) as any[]) {
          const u = row.usuario;
          if (u && !vistos.has(u.usuario_id)) {
            vistos.add(u.usuario_id);
            leitores.push({ usuario_id: u.usuario_id, nome: u.nome });
          }
        }
        leitores.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
        return reply({ data: leitores, error: null });
      }

      case 'catalogoCategorias':
        return q(await sb.from('categoria').select('categoria_id, nome_categoria').order('nome_categoria'));
      case 'catalogoEditoras':
        return q(await sb.from('editora').select('editora_id, nome_editora').order('nome_editora'));
      case 'catalogoAutores':
        return q(await sb.from('autor').select('autor_id, nome_autor').order('nome_autor'));

      case 'dashboardStats':
        return q(await sb.rpc('dashboard_stats'));
      case 'dashboardAtrasos':
        return q(
          await sb
            .from('vw_emprestimos_em_atraso')
            .select('emprestimo_id, nome, titulo, data_retirada, data_prevista, dias_atraso, valor_multa')
            .order('dias_atraso', { ascending: false }),
        );
      case 'dashboardCategorias':
        return q(await sb.rpc('categorias_com_livros'));
      // dashboardAtividade removido em 16/07/2026 — "Atividade Recente" saiu
      // do Painel Geral. O histórico completo de ações agora vive na página
      // Auditoria (ver auditoriaPagina/auditoriaUsuarios, abaixo).

      case 'healthPing':
        return q(await sb.from('editora').select('editora_id').limit(1));

      // ───────── PERFIS (RBAC) ─────────
      case 'perfilMeu':
        return reply({ data: { papel, email: user.email }, error: null });
      case 'perfisListar': {
        // Enriquecido em 18/07/2026 (feedback de design) com created_at,
        // criado_por e ultimo_acesso — a tabela em si continua enxuta
        // (Email/Papel/Status/Último acesso); Criado em/Criado por só
        // aparecem no modal de detalhe, mesma filosofia lista-mínima/
        // detalhe-completo já aplicada em Exemplares (Achado 33).
        const { data: perfis, error } = await sb
          .from('app_perfil')
          .select('id,user_id,email,papel,created_at')
          .order('email');
        if (error) return reply({ data: null, error: { message: error.message } });

        // "Criado por": primeiro log de perfil.definir cujo detalhe.email
        // bate com o perfil (perfilDefinir não grava registro_id, só o
        // e-mail dentro do detalhe — casamos em memória em vez de tentar
        // um filtro JSONB sem precedente no projeto).
        const { data: logsDefinir } = await sb
          .from('log_auditoria')
          .select('usuario_email, criado_em, detalhe')
          .eq('acao', 'perfil.definir')
          .order('criado_em');
        const criadoPorPorEmail: Record<string, string | null> = {};
        for (const l of (logsDefinir || []) as any[]) {
          const em = l.detalhe?.email;
          if (em && !(em in criadoPorPorEmail)) criadoPorPorEmail[em] = l.usuario_email ?? null;
        }

        // "Último acesso": vem de auth.users (last_sign_in_at), não de
        // app_perfil — só a Admin API expõe isso, e só a chave de serviço
        // (já usada nesta função) tem permissão para chamá-la. Falha de
        // forma silenciosa (perfis sem essa info, não a listagem inteira)
        // caso a chamada admin não esteja disponível no ambiente.
        let ultimoAcessoPorUserId: Record<string, string | null> = {};
        try {
          const { data: usersPage } = await sb.auth.admin.listUsers({ perPage: 1000 });
          for (const u of usersPage?.users || []) ultimoAcessoPorUserId[u.id] = u.last_sign_in_at ?? null;
        } catch (_) {
          /* segue sem "último acesso" se a Admin API falhar */
        }

        const out = (perfis || []).map((pf: any) => ({
          ...pf,
          criado_por: criadoPorPorEmail[pf.email] ?? null,
          ultimo_acesso: pf.user_id ? (ultimoAcessoPorUserId[pf.user_id] ?? null) : null,
        }));
        return reply({ data: out, error: null });
      }
      case 'perfilDefinir': {
        const { email, papel: novo } = p;
        if (!email || !PAPEIS.includes(novo))
          return reply({ ok: false, message: 'Informe um e-mail e um papel válido (admin/bibliotecario/consulta).' });
        const { error } = await sb.from('app_perfil').upsert({ email, papel: novo }, { onConflict: 'email' });
        if (error) return reply({ ok: false, message: error.message });
        await logar('perfil.definir', 'app_perfil', null, { email, papel: novo });
        return reply({ ok: true, message: `Papel de ${email} definido como ${novo}.` });
      }
      // Novo em 18/07/2026 (feedback de design, "outra melhoria" — menu de
      // ações do perfil). Guarda-corpos: não permite remover a própria
      // conta (evita se autoexcluir do sistema por engano) nem remover o
      // último administrador (evitaria um estado sem ninguém capaz de
      // gerenciar perfis).
      case 'perfilRemover': {
        const { email } = p;
        if (!email) return reply({ ok: false, message: 'E-mail não informado.' });
        if (email === user.email) return reply({ ok: false, message: 'Você não pode remover o próprio perfil.' });
        const { data: alvo, error: eb } = await sb
          .from('app_perfil')
          .select('id, papel')
          .eq('email', email)
          .maybeSingle();
        if (eb) return reply({ ok: false, message: 'Erro ao verificar perfil: ' + eb.message });
        if (!alvo) return reply({ ok: false, message: 'Perfil não encontrado.' });
        if (alvo.papel === 'admin') {
          const { count: totalAdmins, error: ec } = await sb
            .from('app_perfil')
            .select('id', { count: 'exact', head: true })
            .eq('papel', 'admin');
          if (ec) return reply({ ok: false, message: 'Erro ao verificar administradores: ' + ec.message });
          if ((totalAdmins || 0) <= 1)
            return reply({ ok: false, message: 'Não é possível remover: é o único administrador do sistema.' });
        }
        const { error } = await sb.from('app_perfil').delete().eq('email', email);
        if (error) return reply({ ok: false, message: 'Erro ao remover perfil: ' + error.message });
        await logar('perfil.remover', 'app_perfil', null, { email, papel: alvo.papel });
        return reply({ ok: true, message: `Perfil de ${email} removido.` });
      }
      // Reenvia o convite de acesso (magic link) via Admin API — só faz
      // sentido para perfis ainda pendentes (user_id nulo). Depende de SMTP
      // configurado no projeto Supabase; se não estiver, retorna erro
      // amigável em vez de estourar 500.
      case 'perfilReenviarConvite': {
        const { email } = p;
        if (!email) return reply({ ok: false, message: 'E-mail não informado.' });
        const { data: alvo, error: eb } = await sb
          .from('app_perfil')
          .select('user_id')
          .eq('email', email)
          .maybeSingle();
        if (eb) return reply({ ok: false, message: 'Erro ao verificar perfil: ' + eb.message });
        if (!alvo) return reply({ ok: false, message: 'Perfil não encontrado.' });
        if (alvo.user_id)
          return reply({
            ok: false,
            message: 'Este perfil já está vinculado a uma conta — não é um convite pendente.',
          });
        try {
          const { error } = await sb.auth.admin.inviteUserByEmail(email);
          if (error) return reply({ ok: false, message: 'Erro ao reenviar convite: ' + error.message });
        } catch (e) {
          return reply({
            ok: false,
            message: 'Não foi possível reenviar o convite. Verifique se o envio de e-mail está configurado no projeto.',
          });
        }
        await logar('perfil.reenviar_convite', 'app_perfil', null, { email });
        return reply({ ok: true, message: `Convite reenviado para ${email}.` });
      }

      // Dados do próprio usuário logado (acessível a qualquer papel)
      case 'meusDados': {
        const { data, error } = await sb
          .from('usuario')
          .select('usuario_id, nome, email, cpf, telefone, ativo, data_cadastro')
          .eq('email', user.email)
          .maybeSingle();
        return q({ data, error });
      }

      // Atualiza o próprio perfil (nome + telefone); qualquer papel pode usar
      case 'perfilAtualizar': {
        const { nome, telefone } = p;
        if (!nome?.trim()) return reply({ ok: false, message: 'Nome é obrigatório.' });
        const { data: u } = await sb.from('usuario').select('usuario_id').eq('email', user.email).maybeSingle();
        if (!u) return reply({ ok: false, message: 'Usuário não encontrado no sistema. Contate o administrador.' });
        const upd: Record<string, unknown> = { nome: nome.trim(), telefone: telefone?.trim() || null };
        const { error } = await sb.from('usuario').update(upd).eq('usuario_id', u.usuario_id);
        if (error) return reply({ ok: false, message: 'Erro ao salvar: ' + error.message });
        await logar('perfil.atualizar', 'usuario', u.usuario_id, { nome: nome.trim() });
        return reply({ ok: true, message: 'Perfil atualizado com sucesso.' });
      }

      // ───────── ESCRITAS — usam colunas reais do banco (snake_case + UUID) ─────────
      case 'usuarioCriar': {
        const { nome, email, cpf, telefone } = p;
        if (!nome || !email || !cpf) return reply({ ok: false, message: 'Preencha os campos obrigatórios.' });
        if (!/^\d{11}$/.test(cpf))
          return reply({ ok: false, message: 'CPF deve conter exatamente 11 dígitos numéricos.' });
        if (!validarCPF(cpf)) return reply({ ok: false, message: 'CPF inválido. Verifique os dígitos verificadores.' });
        const { data: novoLeitor, error } = await sb
          .from('usuario')
          .insert({ nome, email, cpf, telefone: telefone || null, ativo: true })
          .select('usuario_id')
          .single();
        if (error) {
          const m = error.message.includes('email')
            ? 'E-mail já cadastrado.'
            : error.message.includes('cpf')
              ? 'CPF já cadastrado.'
              : error.message;
          return reply({ ok: false, message: m });
        }
        await logar('usuario.criar', 'usuario', novoLeitor?.usuario_id ?? null, { nome });
        return reply({ ok: true, message: 'Leitor cadastrado com sucesso.' });
      }
      case 'usuarioAtualizar': {
        const { id, nome, email, telefone } = p;
        if (!nome || !email) return reply({ ok: false, message: 'Preencha nome e e-mail.' });
        // Captura o "antes" para registrar o diff na linha do tempo do leitor
        // (Central do Leitor, Achado 21 — 14/07/2026).
        const { data: antes } = await sb
          .from('usuario')
          .select('nome, email, telefone')
          .eq('usuario_id', id)
          .maybeSingle();
        const { error } = await sb
          .from('usuario')
          .update({ nome, email, telefone: telefone || null })
          .eq('usuario_id', id);
        if (error) return reply({ ok: false, message: 'Erro ao atualizar: ' + error.message });
        const alteracoes: { campo: string; de: string | null; para: string | null }[] = [];
        if (antes) {
          if ((antes.nome || '') !== nome) alteracoes.push({ campo: 'Nome', de: antes.nome ?? null, para: nome });
          if ((antes.email || '') !== email) alteracoes.push({ campo: 'Email', de: antes.email ?? null, para: email });
          if ((antes.telefone || null) !== (telefone || null))
            alteracoes.push({ campo: 'Telefone', de: antes.telefone ?? null, para: telefone || null });
        }
        await logar('usuario.atualizar', 'usuario', id, alteracoes.length ? { alteracoes } : null);
        return reply({ ok: true, message: 'Leitor atualizado com sucesso.' });
      }
      case 'usuarioInativar': {
        const { error } = await sb.from('usuario').update({ ativo: false }).eq('usuario_id', p.id);
        if (error) return reply({ ok: false, message: 'Erro ao inativar: ' + error.message });
        await logar('usuario.inativar', 'usuario', p.id);
        return reply({ ok: true, message: 'Leitor inativado.' });
      }
      case 'usuarioReativar': {
        const { error } = await sb.from('usuario').update({ ativo: true }).eq('usuario_id', p.id);
        if (error) return reply({ ok: false, message: 'Erro ao reativar: ' + error.message });
        await logar('usuario.reativar', 'usuario', p.id);
        return reply({ ok: true, message: 'Leitor reativado.' });
      }

      case 'livroCriar': {
        const { titulo, isbn, ano, categoria_id, editora_id, autoresIds } = p;
        if (!titulo || !isbn || !categoria_id || !editora_id || !(autoresIds || []).length)
          return reply({ ok: false, message: 'Preencha todos os campos obrigatórios, incluindo pelo menos um autor.' });
        const { data: livro, error: e1 } = await sb
          .from('livro')
          .insert({ titulo, isbn, ano_publicacao: ano, categoria_id, editora_id })
          .select('livro_id')
          .single();
        if (e1 || !livro) {
          const m = e1?.message || '';
          return reply({
            ok: false,
            message:
              m.includes('isbn') || m.includes('unique') ? 'ISBN já cadastrado.' : m || 'Erro ao cadastrar livro.',
          });
        }
        const { error: e2 } = await sb
          .from('livro_autor')
          .insert((autoresIds as any[]).map((aid) => ({ livro_id: livro.livro_id, autor_id: aid })));
        if (e2)
          return reply({
            ok: false,
            livro_id: livro.livro_id,
            message: `Livro salvo, mas erro ao vincular autores: ${e2.message}`,
          });
        await logar('livro.criar', 'livro', livro.livro_id, { titulo });
        return reply({ ok: true, livro_id: livro.livro_id, message: 'Livro cadastrado com sucesso!' });
      }
      case 'livroAtualizar': {
        const { id, titulo, isbn, ano, categoria_id, editora_id, autoresIds } = p;
        if (!titulo || !isbn || !categoria_id || !editora_id || !(autoresIds || []).length)
          return reply({ ok: false, message: 'Preencha todos os campos obrigatórios.' });
        const { error: e1 } = await sb
          .from('livro')
          .update({ titulo, isbn, ano_publicacao: ano, categoria_id, editora_id })
          .eq('livro_id', id);
        if (e1) return reply({ ok: false, message: 'Erro: ' + e1.message });
        await sb.from('livro_autor').delete().eq('livro_id', id);
        const { error: e2 } = await sb
          .from('livro_autor')
          .insert((autoresIds as any[]).map((aid) => ({ livro_id: id, autor_id: aid })));
        await logar('livro.atualizar', 'livro', id);
        return reply(
          e2
            ? { ok: true, message: 'Livro atualizado, mas erro ao salvar autores: ' + e2.message }
            : { ok: true, message: 'Livro atualizado com sucesso.' },
        );
      }
      case 'livroExcluir': {
        const { id } = p;
        if (!id) return reply({ ok: false, message: 'Livro não informado.' });
        // livro_autor e reserva têm ON DELETE CASCADE; exemplar tem ON DELETE
        // RESTRICT. Checamos os dois antes de tentar apagar para dar uma
        // mensagem clara em vez de deixar o Postgres estourar um erro de FK
        // (exemplares) ou apagar reservas em silêncio (histórico perdido).
        const [{ count: countEx, error: ce }, { count: countRes, error: re }] = await Promise.all([
          sb.from('exemplar').select('exemplar_id', { count: 'exact', head: true }).eq('livro_id', id),
          sb.from('reserva').select('reserva_id', { count: 'exact', head: true }).eq('livro_id', id),
        ]);
        if (ce) return reply({ ok: false, message: 'Erro ao verificar exemplares: ' + ce.message });
        if (re) return reply({ ok: false, message: 'Erro ao verificar reservas: ' + re.message });
        if ((countEx || 0) > 0)
          return reply({
            ok: false,
            message: `Não é possível excluir: há ${countEx} exemplar(es) cadastrado(s) para este livro. Remova os exemplares primeiro.`,
          });
        if ((countRes || 0) > 0)
          return reply({
            ok: false,
            message: `Não é possível excluir: há ${countRes} reserva(s) associada(s) a este livro.`,
          });
        const { error } = await sb.from('livro').delete().eq('livro_id', id);
        if (error) return reply({ ok: false, message: 'Erro ao excluir: ' + error.message });
        await logar('livro.excluir', 'livro', id);
        return reply({ ok: true, message: 'Livro excluído com sucesso.' });
      }

      // Criação rápida de Categoria/Editora/Autor (17/07/2026) — usada pelo
      // seletor pesquisável ("combo-select"/chip-select com "+ Criar") dentro
      // do próprio modal de cadastro/edição de Livro, para o bibliotecário
      // nunca precisar sair do cadastro do livro para criar um dado auxiliar
      // que ainda não existe. Cada ação faz uma checagem de duplicidade por
      // nome (case-insensitive, ignorando espaços nas pontas) antes de
      // inserir — evita "Categoria"/"categoria "/" categoria" como registros
      // distintos quando o usuário só queria selecionar o já existente.
      case 'categoriaCriar': {
        const nome = String(p.nome || '').trim();
        const descricao = p.descricao ? String(p.descricao).trim() : null;
        if (!nome) return reply({ ok: false, message: 'Informe o nome da categoria.' });
        const { data: existente } = await sb
          .from('categoria')
          .select('categoria_id, nome_categoria')
          .ilike('nome_categoria', nome)
          .maybeSingle();
        if (existente)
          return reply({
            ok: false,
            message: `A categoria "${existente.nome_categoria}" já existe.`,
          });
        const { data: nova, error } = await sb
          .from('categoria')
          .insert({ nome_categoria: nome, descricao })
          .select('categoria_id, nome_categoria')
          .single();
        if (error) return reply({ ok: false, message: 'Erro ao criar categoria: ' + error.message });
        await logar('categoria.criar', 'categoria', nova?.categoria_id ?? null, { nome });
        return reply({
          ok: true,
          message: `Categoria "${nova?.nome_categoria}" criada com sucesso.`,
          data: { categoria_id: nova?.categoria_id, nome_categoria: nova?.nome_categoria },
        });
      }
      case 'editoraCriar': {
        const nome = String(p.nome || '').trim();
        const site = p.site ? String(p.site).trim() : null;
        const cidade = p.cidade ? String(p.cidade).trim() : null;
        if (!nome) return reply({ ok: false, message: 'Informe o nome da editora.' });
        const { data: existente } = await sb
          .from('editora')
          .select('editora_id, nome_editora')
          .ilike('nome_editora', nome)
          .maybeSingle();
        if (existente)
          return reply({
            ok: false,
            message: `A editora "${existente.nome_editora}" já existe.`,
          });
        const { data: nova, error } = await sb
          .from('editora')
          .insert({ nome_editora: nome, site, cidade })
          .select('editora_id, nome_editora')
          .single();
        if (error) return reply({ ok: false, message: 'Erro ao criar editora: ' + error.message });
        await logar('editora.criar', 'editora', nova?.editora_id ?? null, { nome });
        return reply({
          ok: true,
          message: `Editora "${nova?.nome_editora}" criada com sucesso.`,
          data: { editora_id: nova?.editora_id, nome_editora: nova?.nome_editora },
        });
      }
      case 'autorCriar': {
        const nome = String(p.nome || '').trim();
        if (!nome) return reply({ ok: false, message: 'Informe o nome do autor.' });
        const { data: existente } = await sb
          .from('autor')
          .select('autor_id, nome_autor')
          .ilike('nome_autor', nome)
          .maybeSingle();
        if (existente)
          return reply({
            ok: false,
            message: `O autor "${existente.nome_autor}" já existe.`,
          });
        const { data: novo, error } = await sb
          .from('autor')
          .insert({ nome_autor: nome })
          .select('autor_id, nome_autor')
          .single();
        if (error) return reply({ ok: false, message: 'Erro ao criar autor: ' + error.message });
        await logar('autor.criar', 'autor', novo?.autor_id ?? null, { nome });
        return reply({
          ok: true,
          message: `Autor "${novo?.nome_autor}" criado com sucesso.`,
          data: { autor_id: novo?.autor_id, nome_autor: novo?.nome_autor },
        });
      }

      case 'exemplarCriar': {
        // Reforma da tela de Exemplares (16/07/2026): o código patrimonial não
        // é mais digitado — o banco gera automaticamente (DEFAULT
        // gerar_codigo_patrimonial(), ver migration 20260716020000). Status
        // inicial restrito a Disponível/Manutenção/Baixado: "Emprestado" só
        // pode surgir através de um empréstimo de verdade (emprestimoCriar).
        const MOTIVOS_BAIXA = ['Perda', 'Extravio', 'Danificado', 'Descartado', 'Outro'];
        const { livro_id, status, motivo } = p;
        const statusInicial = status || 'Disponivel';
        if (!livro_id) return reply({ ok: false, message: 'Selecione o livro.' });
        if (!['Disponivel', 'Manutencao', 'Baixado'].includes(statusInicial))
          return reply({
            ok: false,
            message:
              'Status inicial inválido. Um exemplar só pode ser cadastrado como Disponível, Manutenção ou Baixado.',
          });
        if (statusInicial === 'Baixado' && !motivo) return reply({ ok: false, message: 'Informe o motivo da baixa.' });
        if (motivo && !MOTIVOS_BAIXA.includes(motivo))
          return reply({ ok: false, message: 'Motivo de baixa inválido.' });
        const { data: novoExemplar, error } = await sb
          .from('exemplar')
          .insert({ livro_id, status: statusInicial, motivo_baixa: statusInicial === 'Baixado' ? motivo : null })
          .select('exemplar_id, codigo_patrimonial')
          .single();
        if (error) return reply({ ok: false, message: error.message });
        await logar('exemplar.criar', 'exemplar', novoExemplar?.exemplar_id ?? null, {
          codigo: novoExemplar?.codigo_patrimonial,
        });
        return reply({
          ok: true,
          message: `Exemplar ${novoExemplar?.codigo_patrimonial} cadastrado com sucesso.`,
          data: { exemplar_id: novoExemplar?.exemplar_id, codigo_patrimonial: novoExemplar?.codigo_patrimonial },
        });
      }
      case 'exemplarAtualizarStatus': {
        // Reforma da tela de Exemplares (16/07/2026): passa a exigir motivo ao
        // baixar (limpo quando o status sai de Baixado), bloqueia setar
        // "Emprestado" manualmente (só via empréstimo) e bloqueia alterar o
        // status de um exemplar que está emprestado no momento (evita deixar o
        // exemplar com um status manual enquanto ainda há um empréstimo aberto
        // apontando para ele — primeiro é preciso devolver).
        const MOTIVOS_BAIXA = ['Perda', 'Extravio', 'Danificado', 'Descartado', 'Outro'];
        const { id, status, motivo } = p;
        if (!id || !status) return reply({ ok: false, message: 'Dados incompletos.' });
        if (status === 'Emprestado')
          return reply({ ok: false, message: 'O status Emprestado só pode ser definido através de um empréstimo.' });
        if (status === 'Baixado' && !motivo) return reply({ ok: false, message: 'Informe o motivo da baixa.' });
        if (motivo && !MOTIVOS_BAIXA.includes(motivo))
          return reply({ ok: false, message: 'Motivo de baixa inválido.' });

        // Captura o "antes" para a página de Auditoria mostrar
        // Campo alterado / Valor anterior / Novo valor (16/07/2026).
        const { data: antesEx } = await sb
          .from('exemplar')
          .select('status, motivo_baixa')
          .eq('exemplar_id', id)
          .maybeSingle();
        if (antesEx?.status === 'Emprestado')
          return reply({
            ok: false,
            message: 'Este exemplar está emprestado — registre a devolução antes de alterar o status.',
          });

        const motivoNovo = status === 'Baixado' ? motivo : null;
        const { error } = await sb.from('exemplar').update({ status, motivo_baixa: motivoNovo }).eq('exemplar_id', id);
        if (error) return reply({ ok: false, message: 'Erro ao atualizar status: ' + error.message });

        // Corrigido em 19/07/2026 (sexta rodada de feedback): antes essa linha
        // sempre registrava "Status alterado" mesmo quando o valor não mudava
        // de fato (ex.: reabrir o modal e salvar de novo, ou editar só o
        // motivo mantendo o mesmo status) — o histórico do exemplar acabava
        // mostrando um "Baixado → Baixado" sem sentido. Cada linha agora só
        // entra em `alteracoes` se o valor realmente mudou, e nada é
        // registrado (nem chamado logar) quando não houve alteração nenhuma.
        const alteracoes: any[] = [];
        if ((antesEx?.status ?? null) !== status) {
          alteracoes.push({ campo: 'Status', de: antesEx?.status ?? null, para: status });
        }
        if ((antesEx?.motivo_baixa ?? null) !== motivoNovo) {
          alteracoes.push({ campo: 'Motivo da baixa', de: antesEx?.motivo_baixa ?? null, para: motivoNovo });
        }
        if (alteracoes.length) {
          await logar('exemplar.status', 'exemplar', id, { alteracoes });
        }
        return reply({ ok: true, message: 'Status atualizado.' });
      }
      case 'exemplarExcluir': {
        // Guarda: nunca excluir um exemplar emprestado ou com histórico de
        // empréstimos (perderia o rastro de circulação/multas associadas) —
        // nesses casos a recomendação é marcar como Baixado, não excluir.
        const { id } = p;
        if (!id) return reply({ ok: false, message: 'Exemplar não informado.' });
        const { data: exAlvo, error: eex } = await sb
          .from('exemplar')
          .select('status, codigo_patrimonial')
          .eq('exemplar_id', id)
          .maybeSingle();
        if (eex) return reply({ ok: false, message: 'Erro ao verificar exemplar: ' + eex.message });
        if (!exAlvo) return reply({ ok: false, message: 'Exemplar não encontrado.' });
        if (exAlvo.status === 'Emprestado')
          return reply({ ok: false, message: 'Não é possível excluir: este exemplar está emprestado.' });
        const { count: countEmp, error: ce } = await sb
          .from('emprestimo')
          .select('emprestimo_id', { count: 'exact', head: true })
          .eq('exemplar_id', id);
        if (ce) return reply({ ok: false, message: 'Erro ao verificar histórico: ' + ce.message });
        if ((countEmp || 0) > 0)
          return reply({
            ok: false,
            message: `Não é possível excluir: este exemplar tem ${countEmp} empréstimo(s) no histórico. Marque como Baixado em vez de excluir.`,
          });
        const { error } = await sb.from('exemplar').delete().eq('exemplar_id', id);
        if (error) return reply({ ok: false, message: 'Erro ao excluir: ' + error.message });
        await logar('exemplar.excluir', 'exemplar', id, { codigo: exAlvo.codigo_patrimonial });
        return reply({ ok: true, message: 'Exemplar excluído com sucesso.' });
      }

      case 'emprestimoCriar': {
        const { usuario_id, exemplar_id, data_retirada, data_prevista } = p;
        if (!usuario_id || !exemplar_id || !data_retirada || !data_prevista)
          return reply({ ok: false, message: 'Preencha todos os campos.' });
        if (data_prevista < data_retirada)
          return reply({ ok: false, message: 'Data prevista deve ser igual ou posterior à data de retirada.' });
        const { data: novoEmprestimo, error } = await sb
          .from('emprestimo')
          .insert({ usuario_id, exemplar_id, data_retirada, data_prevista, data_devolucao: null })
          .select('emprestimo_id')
          .single();
        if (error) return reply({ ok: false, message: error.message });
        await logar('emprestimo.criar', 'emprestimo', novoEmprestimo?.emprestimo_id ?? null, {
          usuario_id,
          exemplar_id,
        });
        return reply({ ok: true, message: 'Empréstimo registrado com sucesso.' });
      }
      case 'emprestimoDevolver': {
        const { error } = await sb.rpc('registrar_devolucao', { p_emprestimo_id: p.id });
        if (error) return reply({ ok: false, message: 'Erro ao registrar devolução: ' + error.message });
        await logar('emprestimo.devolver', 'emprestimo', p.id);
        return reply({ ok: true, message: 'Devolução registrada com sucesso.' });
      }

      case 'reservaCriar': {
        const { usuario_id, livro_id } = p;
        if (!usuario_id || !livro_id) return reply({ ok: false, message: 'Selecione leitor e livro.' });
        const { count, error: ce } = await sb
          .from('exemplar')
          .select('exemplar_id', { count: 'exact', head: true })
          .eq('livro_id', livro_id)
          .eq('status', 'Disponivel');
        if (ce) return reply({ ok: false, message: 'Erro ao verificar disponibilidade: ' + ce.message });
        if ((count || 0) > 0)
          return reply({
            ok: false,
            message: `Há ${count} exemplar(es) disponível(is). Realize um empréstimo diretamente.`,
          });
        const { data: dup } = await sb
          .from('reserva')
          .select('reserva_id')
          .eq('usuario_id', usuario_id)
          .eq('livro_id', livro_id)
          .eq('status', 'Ativa')
          .maybeSingle();
        if (dup) return reply({ ok: false, message: 'Este leitor já tem uma reserva ativa para este livro.' });
        const { data: novaReserva, error } = await sb
          .from('reserva')
          .insert({ usuario_id, livro_id, data_reserva: todayStr(), status: 'Ativa' })
          .select('reserva_id')
          .single();
        if (error) return reply({ ok: false, message: error.message });
        await logar('reserva.criar', 'reserva', novaReserva?.reserva_id ?? null, { usuario_id, livro_id });
        return reply({ ok: true, message: 'Reserva criada com sucesso.' });
      }
      case 'reservaAtualizarStatus': {
        const { id, status } = p;
        // Captura o "antes" para a página de Auditoria (mesmo padrão de
        // exemplarAtualizarStatus/usuarioAtualizar — 16/07/2026).
        const { data: antesRes } = await sb.from('reserva').select('status').eq('reserva_id', id).maybeSingle();
        const { error } = await sb.from('reserva').update({ status }).eq('reserva_id', id);
        if (error) return reply({ ok: false, message: 'Erro ao atualizar reserva: ' + error.message });
        await logar('reserva.status', 'reserva', id, {
          alteracoes: [{ campo: 'Status', de: antesRes?.status ?? null, para: status }],
        });
        return reply({ ok: true, message: `Reserva ${String(status).toLowerCase()}.` });
      }

      case 'multaPagar': {
        const { error } = await sb.from('multa').update({ pago: true }).eq('multa_id', p.id);
        if (error) return reply({ ok: false, message: 'Erro ao registrar pagamento: ' + error.message });
        await logar('multa.pagar', 'multa', p.id);
        return reply({ ok: true, message: 'Pagamento registrado com sucesso.' });
      }

      default:
        return reply({ error: { message: 'Ação desconhecida: ' + action } }, 400);
    }
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    try {
      await sb.from('log_erro').insert({
        acao: action,
        usuario_email: user.email,
        mensagem: msg,
        detalhe: { stack: (e as Error)?.stack ?? null },
      });
    } catch (_) {
      /* ignore */
    }
    console.error('api error:', action, msg);
    return reply({ error: { message: msg } }, 500);
  }
};

// CORS_ORIGIN aceita uma ou mais origens separadas por vírgula (ex.: o site publicado).
// Endereços locais (localhost / 127.0.0.1) são sempre aceitos para desenvolvimento;
// isso não abre acesso aos dados, porque toda chamada continua exigindo sessão válida
// e passando pelo RBAC. A resposta devolve a origem que fez o pedido, se permitida.
const ORIGENS = (CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const ORIGEM_LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const origemPermitida = (origem: string | null): string => {
  if (ORIGENS.length === 0) return '*';
  if (origem && (ORIGENS.includes(origem) || ORIGEM_LOCAL.test(origem))) return origem;
  return ORIGENS[0];
};

Deno.serve(async (req) => {
  const res = await handler(req);
  res.headers.set('Access-Control-Allow-Origin', origemPermitida(req.headers.get('Origin')));
  res.headers.append('Vary', 'Origin');
  return res;
});
