-- ============================================================
-- Página "Auditoria" — histórico completo de ações do sistema,
-- separado do Painel Geral (16/07/2026).
--
-- Contexto: o Painel Geral ("Atividade Recente") misturava dois
-- objetivos diferentes — indicadores para tomada de decisão (KPIs) e
-- rastreabilidade completa de ações (quem fez o quê, quando). A
-- "Atividade Recente" foi removida do dashboard (ver Edge Function:
-- case 'dashboardAtividade' removido) e uma página dedicada de
-- Auditoria assume o papel de trilha de auditoria completa.
--
-- Estratégia (reaproveita a infra de busca fuzzy da Achado 25, ver
-- 20260714220000_busca_fuzzy_unaccent.sql, em vez de duplicar lógica):
--   1. vw_log_auditoria_lista: view sobre log_auditoria com a mesma
--      coluna `busca` já usada pelas outras 6 views de listagem —
--      qualquer termo digitado na Auditoria já usa normalizar_busca/
--      busca_relevancia automaticamente, sem código novo de busca.
--   2. buscar_pagina(): recebe um novo parâmetro p_filtro_gte (>=),
--      espelhando o p_filtro_lte já existente — necessário para o
--      filtro de Período (Hoje/Esta semana/Este mês/Personalizado).
--      Como PostgreSQL trata mudança no número de parâmetros como uma
--      função diferente, a função antiga (9 argumentos) é removida
--      explicitamente antes de recriar com o novo parâmetro.
--   3. 'vw_log_auditoria_lista' entra na whitelist v_views_permitidas.
-- ============================================================

CREATE VIEW vw_log_auditoria_lista WITH (security_invoker = true) AS
SELECT
  l.id, l.usuario_email, l.acao, l.entidade, l.registro_id, l.detalhe, l.criado_em,
  lower(coalesce(l.usuario_email,'')||' '||coalesce(l.acao,'')||' '||coalesce(l.entidade,'')||' '||coalesce(l.registro_id,'')) AS busca
FROM log_auditoria l;

GRANT SELECT ON vw_log_auditoria_lista TO authenticated, service_role;

-- ---- buscar_pagina(): adiciona p_filtro_gte (>=), mantendo eq/lte ----
DROP FUNCTION IF EXISTS buscar_pagina(text, text, int, int, text, boolean, text, boolean, jsonb, jsonb);

CREATE FUNCTION buscar_pagina(
  p_view text, p_termo text DEFAULT '', p_page int DEFAULT 1, p_page_size int DEFAULT 20,
  p_order_col text DEFAULT NULL, p_order_asc boolean DEFAULT true,
  p_order_col2 text DEFAULT NULL, p_order2_asc boolean DEFAULT true,
  p_filtro_eq jsonb DEFAULT '{}'::jsonb, p_filtro_lte jsonb DEFAULT '{}'::jsonb,
  p_filtro_gte jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE(linha jsonb, total bigint)
LANGUAGE plpgsql STABLE SET search_path TO 'public', 'extensions' AS $$
DECLARE
  v_views_permitidas CONSTANT text[] := ARRAY[
    'vw_usuarios_lista','vw_livros_lista','vw_exemplares_lista',
    'vw_emprestimos_lista','vw_reservas_lista','vw_multas_lista',
    'vw_log_auditoria_lista'
  ];
  v_termo text := normalizar_busca(p_termo);
  v_page int := greatest(coalesce(p_page, 1), 1);
  v_page_size int := least(greatest(coalesce(p_page_size, 20), 1), 100);
  v_offset int := (v_page - 1) * v_page_size;
  v_where text := '';
  v_key text;
  v_sql text;
  v_order_by text := '';
BEGIN
  IF p_view IS NULL OR NOT (p_view = ANY(v_views_permitidas)) THEN
    RAISE EXCEPTION 'view de busca não permitida: %', coalesce(p_view, '(nulo)');
  END IF;

  PERFORM set_config('pg_trgm.word_similarity_threshold', '0.45', true);

  FOR v_key IN SELECT jsonb_object_keys(coalesce(p_filtro_eq, '{}'::jsonb)) LOOP
    v_where := v_where || format(' AND t.%I = %L', v_key, p_filtro_eq ->> v_key);
  END LOOP;
  FOR v_key IN SELECT jsonb_object_keys(coalesce(p_filtro_lte, '{}'::jsonb)) LOOP
    v_where := v_where || format(' AND t.%I <= %L', v_key, p_filtro_lte ->> v_key);
  END LOOP;
  FOR v_key IN SELECT jsonb_object_keys(coalesce(p_filtro_gte, '{}'::jsonb)) LOOP
    v_where := v_where || format(' AND t.%I >= %L', v_key, p_filtro_gte ->> v_key);
  END LOOP;

  IF v_termo <> '' THEN
    v_where := v_where || format(' AND busca_relevancia(normalizar_busca(t.busca), %L) IS NOT NULL', v_termo);
    v_order_by := format(
      'busca_relevancia(normalizar_busca(t.busca), %L) ASC, similarity(normalizar_busca(t.busca), %L) DESC',
      v_termo, v_termo
    );
  END IF;

  IF p_order_col IS NOT NULL THEN
    v_order_by := v_order_by || CASE WHEN v_order_by <> '' THEN ', ' ELSE '' END
      || format('t.%I %s', p_order_col, CASE WHEN p_order_asc THEN 'ASC' ELSE 'DESC' END);
  END IF;
  IF p_order_col2 IS NOT NULL THEN
    v_order_by := v_order_by || CASE WHEN v_order_by <> '' THEN ', ' ELSE '' END
      || format('t.%I %s', p_order_col2, CASE WHEN p_order2_asc THEN 'ASC' ELSE 'DESC' END);
  END IF;
  IF v_order_by = '' THEN v_order_by := 't.busca ASC'; END IF;

  v_sql := format(
    'SELECT to_jsonb(t.*) AS linha, count(*) OVER() AS total FROM %I t WHERE true %s ORDER BY %s LIMIT %L OFFSET %L',
    p_view, v_where, v_order_by, v_page_size, v_offset
  );
  RETURN QUERY EXECUTE v_sql;
END; $$;

-- Só a Edge Function (service_role, já contorna RLS) chama esta função.
REVOKE ALL ON FUNCTION buscar_pagina(text, text, int, int, text, boolean, text, boolean, jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION buscar_pagina(text, text, int, int, text, boolean, text, boolean, jsonb, jsonb, jsonb) TO service_role;
