// ESLint (flat config) — front em scripts clássicos (globais compartilhados entre camadas).
// A Edge Function (Deno/TypeScript) é verificada com `deno check`, não com ESLint
// (o parser padrão do ESLint não entende a sintaxe TS nem os imports https:// do Deno).
export default [
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        confirm: 'readonly',
        location: 'readonly',
        supabase: 'readonly',
      },
    },
    rules: {
      // vars: 'local' — só sinaliza variáveis não usadas dentro do próprio escopo de função/bloco.
      // Declarações de nível superior (funções/consts globais) são compartilhadas entre os
      // arquivos de camada via scripts clássicos (onclick="" no HTML, chamadas entre camadas) e
      // o ESLint lint cada arquivo isoladamente, então não enxerga esse uso — sem isso, 100% das
      // declarações top-level do projeto geravam falso positivo (Achado 7 da auditoria 13/07/2026).
      'no-unused-vars': ['warn', { vars: 'local' }],
      'no-undef': 'off', // funções/consts globais são compartilhadas entre os arquivos de camada
    },
  },
];
