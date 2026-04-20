return {
  "neovim/nvim-lspconfig",
  dependencies = {
    "saghen/blink.cmp",
  },
  config = function()
    vim.lsp.enable('ty')
    vim.lsp.inlay_hint.enable(false)
  end,
}
