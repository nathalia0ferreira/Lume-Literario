-- dashboard_stats() nunca retornava exemplares_disponiveis, reservasPendentes
-- e multasEmAberto, apesar de js/ui.js (renderDashboard) sempre ter esperado
-- esses três campos para os cartões "Exemplares Disponíveis" (% do total),
-- "Reservas Pendentes" e "Multas em Aberto" — bug pré-existente desde a
-- migration baseline (20260601000000_baseline.sql), não introduzido nesta
-- sessão. Reportado pelo usuário em 13/07/2026 como "reservas pendentes e
-- multas em aberto não aparecem" no painel geral.
CREATE OR REPLACE FUNCTION public.dashboard_stats()
RETURNS json LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT json_build_object(
    'usuarios',              (SELECT count(*) FROM usuario WHERE ativo),
    'livros',                (SELECT count(*) FROM livro),
    'exemplares',            (SELECT count(*) FROM exemplar),
    'exemplares_disponiveis',(SELECT count(*) FROM exemplar WHERE status = 'Disponivel'),
    'emprestimosAtivos',     (SELECT count(*) FROM emprestimo WHERE data_devolucao IS NULL),
    'reservasPendentes',     (SELECT count(*) FROM reserva WHERE status = 'Ativa'),
    'multasEmAberto',        (SELECT count(*) FROM multa WHERE pago = false)
  );
$$;
