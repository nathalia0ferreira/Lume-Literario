/* ============================================================
   UTIL — helpers puros e utilitários de UI (sem acesso a dados)
   ============================================================ */
const todayStr = () => new Date().toISOString().split('T')[0];

function sanitize(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Normalização "espelho" (acento + caixa) de normalizar_busca() no banco —
// mas sem colapsar espaços, para preservar 1:1 o comprimento de caracteres
// com o texto original e permitir mapear a posição do match de volta ao
// texto não-normalizado (Requisito 8, opcional, do pedido de busca
// inteligente: destacar o trecho encontrado). Cópia necessária: js/util.js
// roda como <script> clássico, sem bundler (mesma fronteira de runtime
// documentada para validarCPF/limparBusca).
// Faixa Unicode das marcas diacríticas combinantes (U+0300–U+036F), geradas
// por normalize('NFD') ao separar uma letra acentuada em base + acento.
const REGEX_MARCAS_DIACRITICAS = new RegExp('[̀-ͯ]', 'g');
function normalizarParaDestaque(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(REGEX_MARCAS_DIACRITICAS, '');
}

// Destaca (com <mark>) a primeira ocorrência do termo buscado dentro do
// texto exibido, ignorando acento/caixa. Sempre escapa (sanitize) as três
// partes do texto antes de remontar, então é seguro contra XSS mesmo que o
// dado contenha caracteres especiais de HTML. Best-effort: só destaca
// quando o termo aparece como um trecho contínuo — buscas fuzzy ou
// multi-palavra fora de ordem não têm uma única posição no texto original,
// então nesses casos apenas o texto sanitizado (sem destaque) é devolvido.
function destacarTrecho(texto, termo) {
  const raw = String(texto ?? '');
  const t = String(termo ?? '').trim();
  if (!t) return sanitize(raw);
  const normRaw = normalizarParaDestaque(raw);
  const normTermo = normalizarParaDestaque(t);
  const idx = normTermo ? normRaw.indexOf(normTermo) : -1;
  if (idx === -1) return sanitize(raw);
  const antes = raw.slice(0, idx);
  const meio = raw.slice(idx, idx + normTermo.length);
  const depois = raw.slice(idx + normTermo.length);
  return `${sanitize(antes)}<mark>${sanitize(meio)}</mark>${sanitize(depois)}`;
}

// Validação de CPF com dígitos verificadores (mod 11).
// Cópia do front (scripts clássicos, sem bundler em dev — não importa
// shared/regras.mjs). Algoritmo canônico e testado: shared/regras.mjs.
// Replicada também em supabase/functions/api/index.ts (Deno).
function validarCPF(cpf) {
  cpf = cpf.replace(/\D/g, '');
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  let soma = 0;
  for (let i = 0; i < 9; i++) soma += parseInt(cpf[i]) * (10 - i);
  let r = (soma * 10) % 11;
  if (r === 10 || r === 11) r = 0;
  if (r !== parseInt(cpf[9])) return false;
  soma = 0;
  for (let i = 0; i < 10; i++) soma += parseInt(cpf[i]) * (11 - i);
  r = (soma * 10) % 11;
  if (r === 10 || r === 11) r = 0;
  return r === parseInt(cpf[10]);
}

function paginationHTML(total, page, section) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (totalPages <= 1) return '';
  const from = (page - 1) * PAGE_SIZE + 1,
    to = Math.min(page * PAGE_SIZE, total);
  let h = `<span>${from}&#8211;${to} de ${total}</span>`;
  if (page > 1) h += `<button class="btn-page" onclick="changePage('${section}',${page - 1})">&#8249;</button>`;
  for (let p = Math.max(1, page - 2); p <= Math.min(totalPages, page + 2); p++)
    h += `<button class="btn-page${p === page ? ' active-page' : ''}" onclick="changePage('${section}',${p})">${p}</button>`;
  if (page < totalPages)
    h += `<button class="btn-page" onclick="changePage('${section}',${page + 1})">&#8250;</button>`;
  return `<div class="pagination-wrap">${h}</div>`;
}

function showAlert(id, msg, type = 'success') {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<div class="alert alert-${type}" role="alert">${sanitize(msg)}</div>`;
  setTimeout(() => {
    if (el) el.innerHTML = '';
  }, 5000);
}

// Com busca no servidor, o hint mostra o total de resultados da consulta atual.
function updateHint(hintId, count, term) {
  const el = document.getElementById(hintId);
  if (!el) return;
  const n = Number(count) || 0;
  el.textContent = term ? `${n} resultado(s) para "${term}"` : `${n} registro(s)`;
}

// Debounce por chave (evita uma chamada à API a cada tecla na busca)
const _searchTimers = {};
function debounce(key, fn, ms = 300) {
  clearTimeout(_searchTimers[key]);
  _searchTimers[key] = setTimeout(fn, ms);
}

// RBAC (UX): só 'consulta' não escreve. A API é quem realmente bloqueia.
const podeEscrever = () => papelAtual !== 'consulta';

function setDbStatus(online) {
  document.getElementById('dbDot').className = 'db-dot' + (online ? ' online' : '');
  document.getElementById('dbStatus').textContent = online ? 'banco conectado' : 'offline';
}

function abrirModal(id) {
  const el = document.getElementById(id);
  el.classList.add('active');
  const first = el.querySelector('input:not([type=hidden]),select');
  if (first) setTimeout(() => first.focus(), 50);
}
function fecharModal(id) {
  document.getElementById(id).classList.remove('active');
}
