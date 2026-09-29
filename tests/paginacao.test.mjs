// Testes da lógica de paginação/busca usada na API (Edge Function).
// intArg/limparBusca vêm de shared/regras.mjs (Achado 5 da auditoria
// 13/07/2026) — este arquivo antes mantinha sua própria cópia colada.
// ATENÇÃO: supabase/functions/api/index.ts continua com uma cópia própria
// de intArg/limparBusca (Deno, fronteira de runtime — ver comentário em
// shared/regras.mjs) e deve seguir espelhando este algoritmo.
// Executar com:  npm test   (ou)   node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intArg, limparBusca } from '../shared/regras.mjs';

function range(page, pageSize) {
  const ps = intArg(pageSize, 20, 100);
  const pg = intArg(page, 1);
  const from = (pg - 1) * ps;
  return { from, to: from + ps - 1 };
}

test('page/pageSize inválidos caem no padrão', () => {
  assert.deepEqual(range(undefined, undefined), { from: 0, to: 19 });
  assert.deepEqual(range(0, 0), { from: 0, to: 19 });
  assert.deepEqual(range(-3, 'abc'), { from: 0, to: 19 });
});

test('calcula o range correto por página', () => {
  assert.deepEqual(range(1, 20), { from: 0, to: 19 });
  assert.deepEqual(range(2, 20), { from: 20, to: 39 });
  assert.deepEqual(range(3, 50), { from: 100, to: 149 });
});

test('pageSize é limitado ao teto de 100', () => {
  assert.deepEqual(range(1, 999), { from: 0, to: 99 });
});

test('limparBusca remove curingas do LIKE e espaços nas pontas', () => {
  assert.equal(limparBusca('  maria  '), 'maria');
  assert.equal(limparBusca('100%_off\\'), '100  off ');
  assert.equal(limparBusca(null), '');
  assert.equal(limparBusca(undefined), '');
});
