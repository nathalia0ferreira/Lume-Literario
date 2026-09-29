-- ============================================================
-- Busca inteligente (fuzzy, tolerante a acento/maiúsculas/erros de
-- digitação) — Achado 25 da auditoria 14/07/2026.
--
-- Estratégia: preserva a coluna `busca` já existente em cada view de
-- listagem (vw_usuarios_lista, vw_livros_lista, vw_exemplares_lista,
-- vw_emprestimos_lista, vw_reservas_lista, vw_multas_lista) — nenhuma
-- view é redefinida. Em vez disso:
--   1. normalizar_busca(text): remove acento, baixa caixa e colapsa
--      espaços — usada tanto no termo digitado quanto no texto
--      buscado, para que "João"/"Joao", "MACHADO"/"machado" e
--      "  Machado  " sejam tratados como equivalentes.
--   2. busca_relevancia(texto, termo): classifica a força do match em
--      5 níveis (1=exato ... 5=aproximado/fuzzy via pg_trgm) e retorna
--      NULL quando não há match algum (nem por substring, nem fuzzy).
--      Múltiplas palavras (separadas por espaço) são exigidas todas,
--      em qualquer ordem, em qualquer posição do texto — cada uma pode
--      bater por substring ou, na falta desta, por similaridade de
--      trigramas (tolerância a erro de digitação, ex.: "Machdo").
--   3. buscar_pagina(...): função genérica chamada via RPC pela Edge
--      Function no lugar do antigo `.ilike('busca', ...)` — devolve as
--      linhas já ordenadas por relevância (quando há termo) e o total
--      para paginação, via `count(*) over()`. Centraliza toda a
--      inteligência da busca no banco: front-end e Edge Function
--      apenas repassam o termo digitado, sem regra de comparação
--      própria (requisito "Frontend"/"Edge Function" do pedido).
--   4. Índices GIN trigram nas colunas individuais mais buscadas
--      (nome, título, autor, editora, categoria, isbn, cpf, email,
--      telefone, código patrimonial) — aceleram busca/autocomplete
--      futuro por coluna isolada e reaproveitam o mesmo
--      normalizar_busca(), então qualquer nova funcionalidade de busca
--      já nasce usando o mesmo mecanismo.
--
-- Limitação conhecida (documentada conscientemente, não um descuido):
-- a busca composta multi-campo via `busca` é avaliada em tempo de
-- consulta — a coluna é resultado de JOIN/GROUP BY em várias views
-- (ex.: vw_livros_lista agrega autores via string_agg), o que impede
-- um índice de expressão "bater" com ela e ser usado pelo planner.
-- Aceitável na escala de uma biblioteca (milhares, não milhões, de
-- linhas por tabela); paginação (LIMIT 20-100) mantém o custo baixo.
-- Caminho de evolução se o volume crescer muito: materializar uma
-- coluna busca_normalizada nas tabelas-base (livro, emprestimo, etc.)
-- mantida por trigger, com índice GIN trgm direto sobre ela.
--
-- Nota de aplicação: aplicada em produção (Supabase MCP) em 4 passos —
-- extensões isoladas primeiro, depois funções+índices, depois um ajuste
-- para fixar `SET search_path TO 'public'` nas funções (mesmo padrão já
-- usado em set_updated_at/dashboard_stats/papel_atual etc. deste
-- schema) em vez de depender do search_path de sessão (que se mostrou
-- inconsistente durante a aplicação da migration), e por fim mover as
-- extensões de `public` para `extensions` — mesmo schema já usado para
-- pgcrypto/uuid-ossp neste projeto — após o Supabase Advisor apontar o
-- aviso de segurança "Extension in Public" logo depois do deploy. Este
-- arquivo já reflete o resultado final consolidado.
-- ============================================================

-- unaccent/pg_trgm vivem no schema `extensions` (não `public`), mesmo
-- padrão já usado neste projeto para pgcrypto/uuid-ossp — evita o aviso
-- "Extension in Public" do Supabase Advisor.
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- unaccent() nativo é STABLE (depende da configuração de dicionário de
-- busca textual), o que impede seu uso em índice de expressão. Padrão
-- oficial do Postgres: envolver numa função IMMUTABLE dedicada
-- (fixando o dicionário 'unaccent'), aceitando que uma futura troca de
-- dicionário exigiria REINDEX — cenário que não se aplica aqui.
CREATE OR REPLACE FUNCTION normalizar_busca(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path TO 'public', 'extensions'
AS $$
  SELECT unaccent('unaccent', lower(regexp_replace(trim($1), '\s+', ' ', 'g')));
$$;

-- Classifica a relevância de `p_termo` dentro de `p_texto_normalizado`
-- (que já deve vir normalizado pelo chamador — normalmente
-- normalizar_busca(view.busca)). Retorna:
--   1 exato · 2 início da palavra/frase · 3 palavra completa (limites
--   de espaço) · 4 correspondência parcial (substring, qualquer
--   posição) · 5 aproximada (fuzzy — só bateu por similaridade de
--   trigramas) · NULL quando não há match algum.
CREATE OR REPLACE FUNCTION busca_relevancia(p_texto_normalizado text, p_termo text)
RETURNS smallint
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_texto text := coalesce(p_texto_normalizado, '');
  v_termo text := normalizar_busca(p_termo);
  v_palavras text[];
  v_palavra text;
  v_todas_ok boolean := true;
  v_alguma_fuzzy boolean := false;
BEGIN
  IF v_termo = '' THEN
    RETURN NULL;
  END IF;

  IF v_texto = v_termo THEN
    RETURN 1;
  END IF;
  IF v_texto LIKE (v_termo || '%') THEN
    RETURN 2;
  END IF;
  IF (' ' || v_texto || ' ') LIKE ('% ' || v_termo || ' %') THEN
    RETURN 3;
  END IF;
  IF v_texto LIKE ('%' || v_termo || '%') THEN
    RETURN 4;
  END IF;

  -- Múltiplas palavras: cada uma precisa aparecer (substring ou, na
  -- falta desta, fuzzy) em algum ponto do texto — ordem não importa.
  v_palavras := regexp_split_to_array(v_termo, '\s+');
  FOREACH v_palavra IN ARRAY v_palavras LOOP
    IF v_palavra = '' THEN
      CONTINUE;
    END IF;
    IF v_texto LIKE ('%' || v_palavra || '%') THEN
      CONTINUE;
    ELSIF v_palavra <% v_texto THEN
      v_alguma_fuzzy := true;
      CONTINUE;
    ELSE
      v_todas_ok := false;
      EXIT;
    END IF;
  END LOOP;

  IF NOT v_todas_ok THEN
    RETURN NULL;
  END IF;

  IF v_alguma_fuzzy THEN
    RETURN 5;
  ELSE
    RETURN 4;
  END IF;
END;
$$;

-- Função genérica de listagem paginada + busca por relevância, chamada
-- via RPC pela Edge Function no lugar do antigo `.ilike('busca', ...)`.
-- `p_view` é validada contra uma lista fixa (nunca vem livre do
-- cliente: a Edge Function decide a view a partir de `action`, não do
-- payload do usuário). `p_filtro_eq`/`p_filtro_lte` recebem pares
-- coluna→valor já resolvidos pela Edge Function — usados para os
-- filtros que cada tela já tinha (status, usuario_id, livro_id,
-- dias_restantes etc.), preservados exatamente como antes.
CREATE OR REPLACE FUNCTION buscar_pagina(
  p_view text,
  p_termo text DEFAULT '',
  p_page int DEFAULT 1,
  p_page_size int DEFAULT 20,
  p_order_col text DEFAULT NULL,
  p_order_asc boolean DEFAULT true,
  p_order_col2 text DEFAULT NULL,
  p_order2_asc boolean DEFAULT true,
  p_filtro_eq jsonb DEFAULT '{}'::jsonb,
  p_filtro_lte jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE(linha jsonb, total bigint)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_views_permitidas CONSTANT text[] := ARRAY[
    'vw_usuarios_lista','vw_livros_lista','vw_exemplares_lista',
    'vw_emprestimos_lista','vw_reservas_lista','vw_multas_lista'
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

  -- Torna o fuzzy um pouco mais tolerante que o padrão da extensão
  -- (0.6) para capturar erros de digitação de 1-2 caracteres, como nos
  -- exemplos do pedido ("Machdo"→Machado, "Jorje"→Jorge). Vale só para
  -- esta transação (RPC = uma chamada = uma transação implícita).
  PERFORM set_config('pg_trgm.word_similarity_threshold', '0.45', true);

  FOR v_key IN SELECT jsonb_object_keys(coalesce(p_filtro_eq, '{}'::jsonb)) LOOP
    v_where := v_where || format(' AND t.%I = %L', v_key, p_filtro_eq ->> v_key);
  END LOOP;
  FOR v_key IN SELECT jsonb_object_keys(coalesce(p_filtro_lte, '{}'::jsonb)) LOOP
    v_where := v_where || format(' AND t.%I <= %L', v_key, p_filtro_lte ->> v_key);
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
  IF v_order_by = '' THEN
    v_order_by := 't.busca ASC';
  END IF;

  v_sql := format(
    'SELECT to_jsonb(t.*) AS linha, count(*) OVER() AS total
       FROM %I t
      WHERE true %s
      ORDER BY %s
      LIMIT %L OFFSET %L',
    p_view, v_where, v_order_by, v_page_size, v_offset
  );

  RETURN QUERY EXECUTE v_sql;
END;
$$;

-- Só a Edge Function (papel service_role, que já contorna RLS) chama
-- esta função — mesma fronteira de confiança que as views hoje, que só
-- são lidas pelo client de service role dentro da Edge Function.
REVOKE ALL ON FUNCTION buscar_pagina(text, text, int, int, text, boolean, text, boolean, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION buscar_pagina(text, text, int, int, text, boolean, text, boolean, jsonb, jsonb) TO service_role;

-- ---- Índices GIN trigram nas colunas individuais mais buscadas ----
-- Aceleram (a) qualquer busca/autocomplete futuro por coluna isolada
-- (ex.: sugestão de autor/editora/categoria) e (b) ILIKE/similaridade
-- direta nessas colunas. Ver nota de limitação no cabeçalho deste
-- arquivo quanto à busca composta multi-campo via `busca`.
CREATE INDEX IF NOT EXISTS idx_usuario_nome_trgm     ON usuario   USING gin (normalizar_busca(nome) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_usuario_email_trgm    ON usuario   USING gin (normalizar_busca(email) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_usuario_cpf_trgm      ON usuario   USING gin (normalizar_busca(cpf) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_usuario_telefone_trgm ON usuario   USING gin (normalizar_busca(telefone) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_livro_titulo_trgm     ON livro     USING gin (normalizar_busca(titulo) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_livro_isbn_trgm       ON livro     USING gin (normalizar_busca(isbn) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_autor_nome_trgm       ON autor     USING gin (normalizar_busca(nome_autor) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_editora_nome_trgm     ON editora   USING gin (normalizar_busca(nome_editora) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_categoria_nome_trgm   ON categoria USING gin (normalizar_busca(nome_categoria) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_exemplar_codigo_trgm  ON exemplar  USING gin (normalizar_busca(codigo_patrimonial) gin_trgm_ops);
