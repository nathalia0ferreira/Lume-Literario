-- Redesenho da tela de Empréstimos (pedido do responsável pelo projeto em
-- 14/07/2026): a lista precisa oferecer filtros por leitor/livro/vencimento
-- e mostrar "dias restantes"/"dias em atraso" em vez de só a data prevista.
--
-- vw_emprestimos_lista não expunha usuario_id/livro_id/exemplar_id (só os
-- nomes/código já resolvidos para exibição), então o front não tinha como
-- filtrar por leitor ou livro. Também não calculava dias_atraso/dias_restantes,
-- que agora ficam centralizados na view (mesma filosofia do resto do projeto:
-- regra de negócio de datas no servidor, não recalculada em JS espalhado).
--
-- Aditivo e sem quebra: view recriada com as mesmas colunas de antes (mesmos
-- nomes, mesma ordem) + colunas novas no fim. Nenhum código existente que já
-- lê esta view (emprestimosPagina, exportações futuras) perde nada.

CREATE OR REPLACE VIEW vw_emprestimos_lista WITH (security_invoker = true) AS
SELECT
  em.emprestimo_id,
  u.nome AS usuario_nome,
  l.titulo AS livro_titulo,
  ex.codigo_patrimonial,
  em.data_retirada, em.data_prevista, em.data_devolucao,
  CASE WHEN em.data_devolucao IS NOT NULL THEN 'Devolvido'
       WHEN em.data_prevista < CURRENT_DATE THEN 'Atrasado' ELSE 'Ativo' END AS situacao,
  lower(coalesce(u.nome,'')||' '||coalesce(l.titulo,'')||' '||coalesce(ex.codigo_patrimonial,'')||' '||coalesce(em.data_retirada::text,'')||' '||coalesce(em.data_prevista::text,'')||' '||coalesce(em.data_devolucao::text,'')) AS busca,
  -- Colunas novas (14/07/2026):
  em.usuario_id,
  l.livro_id,
  em.exemplar_id,
  CASE WHEN em.data_devolucao IS NULL AND em.data_prevista < CURRENT_DATE
       THEN (CURRENT_DATE - em.data_prevista) END AS dias_atraso,
  CASE WHEN em.data_devolucao IS NULL AND em.data_prevista >= CURRENT_DATE
       THEN (em.data_prevista - CURRENT_DATE) END AS dias_restantes
FROM emprestimo em
INNER JOIN usuario  u  ON u.usuario_id   = em.usuario_id
INNER JOIN exemplar ex ON ex.exemplar_id = em.exemplar_id
INNER JOIN livro    l  ON l.livro_id     = ex.livro_id;

NOTIFY pgrst, 'reload schema';
