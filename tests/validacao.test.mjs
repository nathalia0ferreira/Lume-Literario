// Testes da regra de validação de CPF (mesma usada na API e no front).
// Importa a implementação real de shared/regras.mjs (Achado 5 da auditoria
// 13/07/2026): antes este arquivo mantinha sua própria cópia colada do
// algoritmo, então um bug corrigido em shared/regras.mjs podia continuar
// "passando" no teste. Agora o teste exercita o código real.
// ATENÇÃO: js/util.js:validarCPF e supabase/functions/api/index.ts:validarCPF
// continuam com cópias próprias (fronteiras de runtime — ver comentário em
// shared/regras.mjs) e devem seguir espelhando este algoritmo.
// Executar com:  npm test   (ou)   node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarCPF } from '../shared/regras.mjs';

test('aceita um CPF válido', () => {
  assert.equal(validarCPF('529.982.247-25'), true);
  assert.equal(validarCPF('52998224725'), true);
});

test('rejeita CPF com dígito verificador errado', () => {
  assert.equal(validarCPF('52998224724'), false);
});

test('rejeita sequências repetidas', () => {
  assert.equal(validarCPF('11111111111'), false);
  assert.equal(validarCPF('00000000000'), false);
});

test('rejeita tamanho inválido', () => {
  assert.equal(validarCPF('123'), false);
  assert.equal(validarCPF(''), false);
});
