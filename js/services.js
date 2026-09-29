/* ============================================================
   SERVICES — operações de escrita (via API).
   As REGRAS DE NEGÓCIO agora vivem no servidor (Edge Function),
   fonte única de verdade. Aqui só repassamos a intenção do
   usuário e devolvemos { ok, message } para a camada de UI.
   ============================================================ */
const UsuarioService = {
  criar: (d) => apiWrite('usuarioCriar', d),
  atualizar: (id, d) => apiWrite('usuarioAtualizar', { id, ...d }),
  inativar: (id) => apiWrite('usuarioInativar', { id }),
  reativar: (id) => apiWrite('usuarioReativar', { id }),
};

const LivroService = {
  criar: (d) => apiWrite('livroCriar', d),
  atualizar: (id, d) => apiWrite('livroAtualizar', { id, ...d }),
  excluir: (id) => apiWrite('livroExcluir', { id }),
};

// Criação rápida de dados auxiliares (17/07/2026) — usada pelos seletores
// pesquisáveis "+ Criar" dentro do modal de cadastro/edição de Livro.
const CatalogoService = {
  criarCategoria: (nome, descricao) => apiWrite('categoriaCriar', { nome, descricao }),
  criarEditora: (nome, site, cidade) => apiWrite('editoraCriar', { nome, site, cidade }),
  criarAutor: (nome) => apiWrite('autorCriar', { nome }),
};

const ExemplarService = {
  criar: (d) => apiWrite('exemplarCriar', d),
  // motivo adicionado em 16/07/2026 (reforma da tela de Exemplares) —
  // exigido pelo backend quando status='Baixado'.
  atualizarStatus: (id, status, motivo) => apiWrite('exemplarAtualizarStatus', { id, status, motivo }),
  excluir: (id) => apiWrite('exemplarExcluir', { id }),
};

const EmprestimoService = {
  criar: (d) => apiWrite('emprestimoCriar', d),
  devolver: (id) => apiWrite('emprestimoDevolver', { id }),
};

const ReservaService = {
  criar: (d) => apiWrite('reservaCriar', d),
  atualizarStatus: (id, status) => apiWrite('reservaAtualizarStatus', { id, status }),
};

const MultaService = {
  pagar: (id) => apiWrite('multaPagar', { id }),
};
