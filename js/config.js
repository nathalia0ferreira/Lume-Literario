/* ============================================================
   CONFIG — conexão com o Supabase e estado global compartilhado
   Camada: configuração. Não contém regra de negócio nem DOM.
   ============================================================ */
const SUPA_URL = 'https://znlsspbnxszcwteqpqlu.supabase.co';
// Chave anônima (pública por design). ATENÇÃO: só é segura com RLS restritivo.
// Ver Auditoria Técnica, Parte 3 — Segurança.
const SUPA_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpubHNzcGJueHN6Y3d0ZXFwcWx1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3MTE5ODksImV4cCI6MjEwNjI4Nzk4OX0.QihIA7wUO1Of2E2By2tmpX82Oa6j9cCZlPbgvDttS1M';

const sb = supabase.createClient(SUPA_URL, SUPA_KEY);

/* Constantes de domínio */
// VALOR_DIA_PADRAO é usado apenas para estimativas visuais no painel.
// O cálculo real da multa é feito pelo banco (coluna gerada + registrar_devolucao()).
const VALOR_DIA_PADRAO = 2.0;
const PAGE_SIZE = 20;

/* Estado de UI compartilhado entre as camadas.
   Com paginação no servidor, o front NÃO guarda mais listas inteiras:
   mantém apenas a página atual de cada seção (a busca vem do input). */
let pendingOp = false;
const pageState = { usuarios: 1, livros: 1, exemplares: 1, emprestimos: 1, reservas: 1, multas: 1, auditoria: 1 };

/* RBAC: papel do usuário logado (admin | bibliotecario | consulta).
   Default otimista: a fonte de verdade é a API (que bloqueia 'consulta').
   Aqui só controlamos a UX — escondemos controles quando confirmado 'consulta'. */
let papelAtual = 'admin';
let usuarioEmail = '';
