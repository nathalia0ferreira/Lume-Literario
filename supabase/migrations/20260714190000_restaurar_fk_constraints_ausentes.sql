-- A migration 20260714105046_uuid_snake_case_b6 recriou as tabelas de
-- domínio com PKs UUID/snake_case, mas não recriou nenhuma das 10
-- foreign keys que existiam antes (confirmado: `select * from pg_constraint
-- where contype='f'` não retornava nenhuma linha em public.* em 14/07/2026).
-- Isso não quebrava nada visivelmente porque o app nunca dependia de
-- CASCADE/RESTRICT em si (livroExcluir, por exemplo, já fazia sua própria
-- checagem manual) — mas quebrava qualquer select aninhado do PostgREST
-- (ex.: "exemplar:exemplar_id(...)", usado em usuarioDetalhe,
-- exemplaresDisponiveis, livroParaEdicao), que depende de FKs para resolver
-- o relacionamento. Sem elas, PostgREST responde com um erro de
-- "no relationship found" e a ação inteira falha.
--
-- Nenhuma linha órfã encontrada (verificado antes desta migration) — seguro
-- restaurar exatamente as constraints já documentadas em db/schema.sql.

ALTER TABLE livro       ADD CONSTRAINT livro_editora_id_fkey      FOREIGN KEY (editora_id)    REFERENCES editora(editora_id)     ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE livro       ADD CONSTRAINT livro_categoria_id_fkey    FOREIGN KEY (categoria_id)  REFERENCES categoria(categoria_id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE livro_autor ADD CONSTRAINT livro_autor_livro_id_fkey FOREIGN KEY (livro_id)      REFERENCES livro(livro_id)         ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE livro_autor ADD CONSTRAINT livro_autor_autor_id_fkey FOREIGN KEY (autor_id)      REFERENCES autor(autor_id)         ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE exemplar    ADD CONSTRAINT exemplar_livro_id_fkey     FOREIGN KEY (livro_id)      REFERENCES livro(livro_id)         ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE emprestimo  ADD CONSTRAINT emprestimo_usuario_id_fkey FOREIGN KEY (usuario_id)    REFERENCES usuario(usuario_id)     ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE emprestimo  ADD CONSTRAINT emprestimo_exemplar_id_fkey FOREIGN KEY (exemplar_id)  REFERENCES exemplar(exemplar_id)   ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE multa       ADD CONSTRAINT multa_emprestimo_id_fkey   FOREIGN KEY (emprestimo_id) REFERENCES emprestimo(emprestimo_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE reserva     ADD CONSTRAINT reserva_usuario_id_fkey    FOREIGN KEY (usuario_id)    REFERENCES usuario(usuario_id)     ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE reserva     ADD CONSTRAINT reserva_livro_id_fkey      FOREIGN KEY (livro_id)      REFERENCES livro(livro_id)         ON UPDATE CASCADE ON DELETE CASCADE;

NOTIFY pgrst, 'reload schema';
