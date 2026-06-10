return {
  "neovim/nvim-lspconfig",
  config = function()
    vim.lsp.enable('ty')
    vim.lsp.inlay_hint.enable(false)
    -- Disable diagnostic signs (blue circles in signcolumn)
    vim.diagnostic.config({ signs = false })
  end,
}
