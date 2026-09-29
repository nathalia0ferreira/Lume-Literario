# Contribuindo com o Lume Literário

Guia rápido de Git, fluxo de trabalho e da esteira de CI/CD.

## Pré-requisitos

- Node.js 20+ (para lint, formatação e testes)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (para migrations e Edge Function)
- Um servidor web local para servir o front (ex.: `python -m http.server 8000`)

```bash
npm install            # instala eslint + prettier
npm run lint           # ESLint (front, js/)
npm run format         # aplica Prettier
npm run format:check   # checa formatação
npm test               # node --test
npm run check:functions # type-check da Edge Function (requer Deno)
```

> **Primeira vez:** o Prettier foi adicionado depois do código existir. Rode
> `npm run format` uma vez e faça commit para normalizar a base inteira (front + novos
> arquivos). Depois disso, `format:check` fica verde e a CI o mantém assim.

## Fluxo de branches

| Branch        | Ambiente    | Deploy automático                 |
| ------------- | ----------- | --------------------------------- |
| `main`        | Produção    | sim (workflow `Deploy`)           |
| `staging`     | Homologação | sim (workflow `Deploy`)           |
| `feature/...` | —           | só roda a CI (lint/formato/teste) |

Fluxo recomendado:

1. Crie a branch a partir de `staging`: `git checkout -b feature/minha-mudanca`.
2. Faça commits pequenos e descritivos (sugestão: [Conventional Commits](https://www.conventionalcommits.org/), ex.: `feat: paginação no servidor`).
3. Abra um Pull Request para `staging`. A **CI precisa passar** (lint + formato + testes).
4. Após validar em homologação, promova `staging` → `main` via PR.

> Branches `main` e `staging` devem ser protegidas (exigir PR + CI verde).

## Banco de dados (migrations versionadas)

As alterações de schema vivem em `supabase/migrations/` (uma migration por mudança, com timestamp). `db/schema.sql` é a versão legível e completa do schema — **mantenha-o sincronizado**: ao criar ou alterar uma migration, reflita a mudança em `db/schema.sql` também.

- **Nunca** edite uma migration já aplicada em produção — crie uma nova.
- Ao criar uma migration, atualize `db/schema.sql` para refletir o estado final resultante.
- A CI **bloqueia o PR** se `supabase/migrations/` mudar sem `db/schema.sql` também mudar no mesmo diff (ver `.github/workflows/ci.yml`, passo "db/schema.sql sincronizado com as migrations") — é um lembrete automático, não substitui revisar se o conteúdo do `schema.sql` está mesmo correto.
- O deploy roda `supabase db push` (aplica migrations pendentes) e republica a Edge Function `api`.
- Para reproduzir do zero (ex.: novo projeto de staging), as migrations recriam tudo: baseline + incrementos.

```bash
# desenvolvimento local opcional
supabase start
supabase db reset      # aplica todas as migrations + seed
supabase functions serve api
```

## Ambiente de homologação (staging)

Use um **segundo projeto Supabase** dedicado a homologação, separado do de produção. Configure os segredos por ambiente no GitHub (Settings → Environments → `staging` e `production`):

- `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`.

A branch `staging` faz deploy nesse projeto; `main` no de produção. As mesmas migrations são aplicadas nos dois, garantindo paridade.

## Estilo de código

- ESLint (flat config) e Prettier definem o padrão. Rode `npm run format` antes de commitar.
- Front em camadas (`config → util → auth → api → repositories → services → ui → app`); mantenha cada arquivo na sua responsabilidade.
