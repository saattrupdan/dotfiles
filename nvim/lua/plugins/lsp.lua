return {
  "neovim/nvim-lspconfig",
  config = function()
    vim.lsp.enable('ty')
    vim.lsp.inlay_hint.enable(false)
  end,
}
