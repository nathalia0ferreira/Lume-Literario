/* ============================================================
   API CLIENT — único ponto de saída do navegador para o back-end.
   O navegador NÃO acessa mais o banco diretamente: tudo passa
   pela Edge Function "api" (que roda com a chave de serviço e
   valida a sessão). Envia o token da sessão em cada chamada.
   ============================================================ */
const API_URL = SUPA_URL + '/functions/v1/api';

async function _api(action, payload) {
  let token = SUPA_KEY; // fallback (a função rejeita se não houver usuário real)
  try {
    const { data } = await sb.auth.getSession();
    if (data.session?.access_token) token = data.session.access_token;
  } catch {}
  let res, body;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + token },
      body: JSON.stringify({ action, payload: payload || {} }),
    });
    body = await res.json();
  } catch (e) {
    return { data: null, count: null, error: { message: 'Falha de conexão com a API: ' + (e?.message || e) } };
  }
  if (body == null) body = { error: { message: 'Resposta vazia da API (HTTP ' + res?.status + ').' } };
  return body;
}

// Leituras → mesma forma do supabase-js: { data, error, count }
const apiQuery = (action, payload) => _api(action, payload);

// Escritas → { ok, message, ... } (regras validadas no servidor)
async function apiWrite(action, payload) {
  const b = await _api(action, payload);
  if (b && b.ok === undefined) return { ok: false, message: (b.error && b.error.message) || 'Erro inesperado.' };
  return b;
}
