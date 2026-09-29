-- ============================================================
-- Criação rápida de Categoria/Editora/Autor no cadastro de Livro (17/07/2026).
-- Pedido: permitir cadastrar Categoria e Editora sem sair do modal de
-- cadastro/edição de Livro. Os mini-formulários de criação rápida pedem
-- campos opcionais que ainda não existiam no schema:
--   - Categoria: "Descrição (opcional)"
--   - Editora: "Site (opcional)" — "Cidade (opcional)" já existe (editora.cidade)
-- Autor não precisa de coluna nova: o mini-formulário pede só "Nome",
-- e autor.nome_autor já existe (nacionalidade já era opcional e não faz
-- parte do formulário rápido).
-- ============================================================

ALTER TABLE categoria ADD COLUMN descricao text;
ALTER TABLE editora   ADD COLUMN site varchar(200);
