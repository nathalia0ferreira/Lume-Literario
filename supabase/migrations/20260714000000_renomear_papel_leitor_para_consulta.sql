-- Renomeia o papel RBAC 'leitor' -> 'consulta'. Motivo: colisão de
-- nome com a tabela `usuario` (leitores/patronos da biblioteca, uma
-- entidade totalmente separada que não acessa o sistema). Pedido
-- explícito do responsável pelo projeto em 14/07/2026, junto com a
-- renomeação da tela "Usuários" -> "Leitores", o painel de detalhes
-- do leitor e os novos KPIs de leitores com empréstimos/multas.
--
-- 'admin' e 'bibliotecario' não mudam. As policies de RLS de escrita
-- (public.papel_atual() IN ('admin','bibliotecario')) checam uma
-- allow-list das outras duas roles, não o valor 'leitor' em si — não
-- precisam de alteração.

ALTER TABLE public.app_perfil DROP CONSTRAINT IF EXISTS chk_papel;

UPDATE public.app_perfil SET papel = 'consulta' WHERE papel = 'leitor';

ALTER TABLE public.app_perfil ALTER COLUMN papel SET DEFAULT 'consulta';

ALTER TABLE public.app_perfil
  ADD CONSTRAINT chk_papel CHECK (papel IN ('admin','bibliotecario','consulta'));
