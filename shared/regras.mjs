// ============================================================
//  Lume Literário — regras puras compartilhadas (sem dependências)
//  (Auditoria 13/07/2026, Achado 5)
//
//  Objetivo: dar aos testes (Node/ESM) uma fonte única e importável
//  para a lógica de validação de CPF e paginação/busca, em vez de
//  cada teste manter sua própria cópia colada do algoritmo.
//
//  Onde a fronteira de runtime NÃO permite importar este módulo
//  diretamente, a lógica continua replicada por necessidade real
//  (documentado em cada cópia):
//    - js/util.js:validarCPF        → browser, scripts clássicos
//      sem bundler em dev (`<script src="js/util.js">`, sem
//      `type="module"`); não pode fazer `import` deste arquivo.
//    - supabase/functions/api/index.ts:validarCPF/intArg/limparBusca
//      → Deno, roda isolado como Edge Function; import relativo para
//      fora de supabase/functions/ não é garantido no bundle do deploy.
//  Ambas as cópias devem continuar espelhando o algoritmo abaixo.
// ============================================================

/** Validação de CPF com dígitos verificadores (módulo 11). */
export function validarCPF(cpf) {
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

/** Normaliza um argumento numérico de paginação (page/pageSize). */
export function intArg(v, def, max = Number.MAX_SAFE_INTEGER) {
  const n = parseInt(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

/** Remove curingas do LIKE/ILIKE (evita busca imprevisível/injeção de padrão). */
export function limparBusca(s) {
  return String(s ?? '')
    .trim()
    .replace(/[%_\\]/g, ' ');
}
