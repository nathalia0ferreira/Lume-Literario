# Changelog

Registro de mudanças estruturais relevantes que não cabem em uma migration comentada. Formato livre, cronológico (mais recente primeiro).

---

## 2026-06-13 — Migração para snake_case + UUID (padrão oficial)

A migration `supabase/migrations/20260613020000_uuid_snake_case.sql` converteu o schema do banco de camelCase + `SERIAL` (baseline `20260601`) para **snake_case + UUID**, hoje o padrão oficial documentado em `db/schema.sql`.

Durante a transição, existiu um arquivo `supabase/sql/compat_views_camelcase.sql` com views de compatibilidade que faziam bridge entre o schema legado e a camada de API/front-end. Após a migration, essas views deixaram de ser necessárias — as views de lista paginada (`vw_*_lista`) e de relatório passaram a ser definidas diretamente em `db/schema.sql` e nas migrations subsequentes, operando sobre as colunas nativas em snake_case/UUID, sem aliases de compatibilidade.

O arquivo `compat_views_camelcase.sql` foi removido em 13/07/2026 (Achado 12 da auditoria técnica) por conter apenas um comentário histórico, sem nenhum SQL executável — mantido aqui como registro.
