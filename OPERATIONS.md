# Runbook operacional — Lume Literário

Procedimentos que dependem do **painel/conta do Supabase** (não resolvíveis só por código) e operação do sistema. Itens da auditoria: SEG‑1, SEG‑2 (senha), SEG-3 (CORS), D2, B6.

---

## SEG‑1 — Ativar proteção contra senha vazada (HaveIBeenPwned)

No projeto de **produção** e no de **homologação**:

1. Supabase → **Authentication** → **Policies** (ou **Providers → Email**) → seção **Password security**.
2. Ative **"Check passwords against HaveIBeenPwned"** (proteção contra senha vazada).
3. Defina **tamanho mínimo de senha** ≥ 10 e exija classes de caracteres, se disponível.
4. Salve e confirme em **Advisors → Security** que o alerta de _leaked password protection_ sumiu.

> Verificação rápida pela API/CLI: `supabase` não expõe esse toggle; valide pelo painel ou via Management API (`PATCH /v1/projects/{ref}/config/auth`, campo `password_hibp_enabled`).

---

## SEG‑2 — Trocar a senha inicial e gerir perfis

### Senha inicial

1. Supabase → **Authentication → Users** → usuário `adminlume@lume.local`.
2. **Reset password** / definir uma senha forte (gerenciador de senhas recomendado).
3. Nunca versione a senha. Login na app: digite só o usuário; o domínio é completado.

### Perfis de acesso (RBAC) — já implementado no código

Papéis: **admin**, **bibliotecario**, **leitor**.

- **leitor:** somente consulta (a API bloqueia escrita; o front esconde formulários e botões).
- **bibliotecario:** todas as operações do dia a dia (usuários, livros, exemplares, empréstimos, reservas, multas).
- **admin:** tudo + gestão de papéis.

A fonte de verdade é a tabela `app_perfil` e o enforcement vive na Edge Function `api`.

**Bootstrap do 1º admin:** a migration semeia `adminlume@lume.local` como `admin` (vincula o `user_id` no primeiro login). Se o seu admin tiver outro e‑mail, ajuste:

```sql
insert into app_perfil (email, papel) values ('SEU-ADMIN@dominio', 'admin')
on conflict (email) do update set papel = 'admin';
```

**Definir papel de alguém** (apenas admin), via API (`perfilDefinir`) ou SQL:

```sql
update app_perfil set papel = 'bibliotecario' where email = 'fulano@dominio';
-- novos usuários entram como 'leitor' por padrão (menor privilégio)
```

---

## SEG‑3 — Restringir CORS_ORIGIN da Edge Function `api`

Por padrão, sem essa variável configurada, a função libera `Access-Control-Allow-Origin: *` (qualquer origem) — mitigado pela exigência de sessão válida + RBAC, mas não é o ideal (Achado 9 da auditoria 13/07/2026).

No projeto de **produção** e no de **homologação**:

1. Supabase → **Edge Functions** → função `api` → **Secrets** (ou **Settings → Secrets** do projeto).
2. Adicione `CORS_ORIGIN` com a URL exata do front em produção (ex.: `https://seu-dominio.com`, sem barra final).
3. Reimplante a função (`supabase functions deploy api` ou via CD) para o secret ser lido no próximo cold start.
4. Confirme em **Edge Functions → Logs** que o aviso `"CORS_ORIGIN não definido..."` não aparece mais nas invocações seguintes.

> O código (`supabase/functions/api/index.ts`) já loga um aviso em `console.error`/`console.warn` quando a variável está ausente, mas só a configuração do secret no painel resolve de fato — isso não é algo que o repositório consiga aplicar sozinho.

---

## D2 — Backup (PITR) e observabilidade

### Validar backup / PITR

1. Supabase → **Database → Backups**. Confirme backups diários (e **PITR** se o plano permitir).
2. **Teste de restauração** (trimestral): restaure para um projeto/branch descartável e valide que a app sobe e os dados conferem. Anote data e responsável.
3. Defina e registre o **RPO/RTO** aceitáveis do projeto.

### Observabilidade

- **Erros da API:** a Edge Function grava exceções em `public.log_erro` e também em `console.error` (visível em **Edge Functions → Logs**). Consulta:
  ```sql
  select criado_em, acao, usuario_email, mensagem
  from log_erro order by criado_em desc limit 50;
  ```
- **Auditoria de escrita:** `public.log_auditoria` (quem fez o quê).
- **Logs/alertas:** Supabase → **Logs**; configure **Log Drains**/alertas (ou um serviço de error tracking) para notificar em picos de erro. Métricas do banco em **Reports**.

---

## B6 — Nomenclatura / IDs sequenciais (CONVERTIDO — validar em staging)

Implementado: PKs de domínio viram **UUID** e tudo em **snake_case**, preservando os dados.
Migration: `supabase/migrations/20260613020000_uuid_snake_case.sql` (transação única → rollback atômico em caso de falha). Edge Function e front já adaptados.

⚠️ É uma migração **destrutiva/irreversível**. Antes de aplicar em produção:

1. **Backup/PITR**: garanta um backup recente (Database → Backups) e/ou snapshot.
2. **Staging primeiro**: faça merge na branch `staging` e deixe o deploy aplicar (`supabase db push`). Confirme que a migração concluiu sem erro.
3. **Smoke test em staging**: logar, listar/buscar em todas as abas, criar/editar livro, registrar e devolver empréstimo, criar reserva e quitar multa. Verifique que os IDs aparecem como UUID e que nada quebrou.
4. **Produção**: só então promova `staging` → `main`. Se algo falhar no `db push`, a transação reverte sozinha; investigue no staging antes de tentar de novo.
5. **Rollback**: como é irreversível por design, o plano de reversão é **restaurar do backup/PITR** anterior à migração.

> Nota: as tabelas internas de log (`log_auditoria`, `log_erro`) e `app_perfil` mantêm seus ids próprios (bigint/uuid) — a conversão vale para as entidades de domínio.

---

## Checklist de produção (resumo)

- [ ] HIBP + senha mínima ativados (prod e staging) — SEG‑1
- [ ] Senha do admin trocada e guardada com segurança — SEG‑2
- [ ] Papéis atribuídos (admin/bibliotecario/leitor) — SEG‑2
- [ ] `CORS_ORIGIN` configurado nos secrets da Edge Function (prod e staging) — SEG‑3
- [ ] Backups confirmados + 1 restauração testada documentada — D2
- [ ] Alertas de erro configurados sobre `log_erro`/Logs — D2
- [ ] Segredos do CI nos Environments `production`/`staging` — D1
