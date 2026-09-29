-- ============================================================
--  Lume Literário — Views de LISTAS PAGINADAS (P1)
--  Objetivo: mover paginação, busca e agregações para o servidor.
--  Cada view expõe uma coluna `busca` (texto em minúsculas) para
--  filtro server-side via ILIKE, além dos campos já agregados que
--  antes o front montava baixando listas inteiras.
--  Consumidas pela Edge Function "api" (service_role) com
--  .range()/.order()/.ilike() + { count: 'exact' }.
--  security_invoker = true → respeita o RLS de quem consulta.
-- ============================================================

-- ---------- Usuários ----------
DROP VIEW IF EXISTS public.vw_usuarios_lista CASCADE;
CREATE VIEW public.vw_usuarios_lista WITH (security_invoker = true) AS
SELECT
  u.usuarioid, u.nome, u.email, u.cpf, u.telefone, u.ativo,
  lower(
    coalesce(u.nome,'')     || ' ' || coalesce(u.email,'') || ' ' ||
    coalesce(u.cpf,'')      || ' ' || coalesce(u.telefone,'')
  ) AS busca
FROM public.usuario u;

-- ---------- Livros (com autores + contagem de exemplares) ----------
DROP VIEW IF EXISTS public.vw_livros_lista CASCADE;
CREATE VIEW public.vw_livros_lista WITH (security_invoker = true) AS
SELECT
  l.livroid, l.titulo, l.isbn, l.anopublicacao,
  cat.nomecategoria, ed.nomeeditora,
  COALESCE(string_agg(DISTINCT a.nomeautor, ', '), '') AS autores,
  COUNT(DISTINCT ex.exemplarid) AS total_ex,
  COUNT(DISTINCT ex.exemplarid) FILTER (WHERE ex.status = 'Disponivel') AS disp,
  lower(
    coalesce(l.titulo,'')                    || ' ' ||
    coalesce(l.isbn,'')                       || ' ' ||
    coalesce(string_agg(DISTINCT a.nomeautor, ' '), '') || ' ' ||
    coalesce(l.anopublicacao::text,'')        || ' ' ||
    coalesce(cat.nomecategoria,'')            || ' ' ||
    coalesce(ed.nomeeditora,'')
  ) AS busca
FROM public.livro l
INNER JOIN public.editora   ed  ON ed.editoraid    = l.editoraid
INNER JOIN public.categoria cat ON cat.categoriaid = l.categoriaid
LEFT  JOIN public.livro_autor la ON la.livroid     = l.livroid
LEFT  JOIN public.autor       a  ON a.autorid       = la.autorid
LEFT  JOIN public.exemplar    ex ON ex.livroid      = l.livroid
GROUP BY l.livroid, l.titulo, l.isbn, l.anopublicacao, cat.nomecategoria, ed.nomeeditora;

-- ---------- Exemplares ----------
DROP VIEW IF EXISTS public.vw_exemplares_lista CASCADE;
CREATE VIEW public.vw_exemplares_lista WITH (security_invoker = true) AS
SELECT
  e.exemplarid, e.codigopatrimonial, e.status, e.livroid,
  l.titulo,
  lower(
    coalesce(e.codigopatrimonial,'') || ' ' ||
    coalesce(e.status,'')            || ' ' ||
    coalesce(l.titulo,'')
  ) AS busca
FROM public.exemplar e
INNER JOIN public.livro l ON l.livroid = e.livroid;

-- ---------- Empréstimos (com situação calculada) ----------
DROP VIEW IF EXISTS public.vw_emprestimos_lista CASCADE;
CREATE VIEW public.vw_emprestimos_lista WITH (security_invoker = true) AS
SELECT
  em.emprestimoid,
  u.nome  AS usuario_nome,
  l.titulo AS livro_titulo,
  ex.codigopatrimonial,
  em.dataretirada, em.dataprevista, em.datadevolucao,
  CASE
    WHEN em.datadevolucao IS NOT NULL     THEN 'Devolvido'
    WHEN em.dataprevista  <  CURRENT_DATE THEN 'Atrasado'
    ELSE 'Ativo'
  END AS situacao,
  lower(
    coalesce(u.nome,'')                 || ' ' ||
    coalesce(l.titulo,'')               || ' ' ||
    coalesce(ex.codigopatrimonial,'')   || ' ' ||
    em.emprestimoid::text               || ' ' ||
    coalesce(em.dataretirada::text,'')  || ' ' ||
    coalesce(em.dataprevista::text,'')  || ' ' ||
    coalesce(em.datadevolucao::text,'')
  ) AS busca
FROM public.emprestimo em
INNER JOIN public.usuario  u  ON u.usuarioid   = em.usuarioid
INNER JOIN public.exemplar ex ON ex.exemplarid = em.exemplarid
INNER JOIN public.livro    l  ON l.livroid     = ex.livroid;

-- ---------- Reservas (com posição na fila entre as ativas) ----------
DROP VIEW IF EXISTS public.vw_reservas_lista CASCADE;
CREATE VIEW public.vw_reservas_lista WITH (security_invoker = true) AS
SELECT
  r.reservaid,
  u.nome  AS usuario_nome,
  l.titulo AS livro_titulo,
  r.livroid, r.datareserva, r.status,
  CASE WHEN r.status = 'Ativa' THEN (
    SELECT count(*) FROM public.reserva r2
    WHERE r2.livroid = r.livroid
      AND r2.status = 'Ativa'
      AND (r2.datareserva, r2.reservaid) <= (r.datareserva, r.reservaid)
  ) END AS fila,
  lower(
    r.reservaid::text          || ' ' ||
    coalesce(u.nome,'')        || ' ' ||
    coalesce(l.titulo,'')      || ' ' ||
    coalesce(r.status,'')      || ' ' ||
    coalesce(r.datareserva::text,'')
  ) AS busca
FROM public.reserva r
INNER JOIN public.usuario u ON u.usuarioid = r.usuarioid
INNER JOIN public.livro   l ON l.livroid   = r.livroid;

-- ---------- Multas (valor/dias atualizados ao vivo se em aberto) ----------
DROP VIEW IF EXISTS public.vw_multas_lista CASCADE;
CREATE VIEW public.vw_multas_lista WITH (security_invoker = true) AS
SELECT
  m.multaid,
  u.nome  AS usuario_nome,
  l.titulo AS livro_titulo,
  m.valordia, m.pago,
  (em.datadevolucao IS NULL) AS aberto,
  CASE WHEN em.datadevolucao IS NULL
       THEN GREATEST(0, CURRENT_DATE - em.dataprevista)
       ELSE m.diasatraso END AS dias,
  CASE WHEN em.datadevolucao IS NULL
       THEN GREATEST(0, CURRENT_DATE - em.dataprevista)::numeric * m.valordia
       ELSE m.valortotal END AS total,
  lower(
    m.multaid::text       || ' ' ||
    coalesce(u.nome,'')   || ' ' ||
    coalesce(l.titulo,'') || ' ' ||
    CASE WHEN m.pago THEN 'pago' ELSE 'pendente' END
  ) AS busca
FROM public.multa m
INNER JOIN public.emprestimo em ON em.emprestimoid = m.emprestimoid
INNER JOIN public.usuario    u  ON u.usuarioid     = em.usuarioid
INNER JOIN public.exemplar   ex ON ex.exemplarid   = em.exemplarid
INNER JOIN public.livro      l  ON l.livroid       = ex.livroid;

-- ---------- Permissões ----------
GRANT SELECT ON
  public.vw_usuarios_lista,
  public.vw_livros_lista,
  public.vw_exemplares_lista,
  public.vw_emprestimos_lista,
  public.vw_reservas_lista,
  public.vw_multas_lista
TO authenticated, service_role;
