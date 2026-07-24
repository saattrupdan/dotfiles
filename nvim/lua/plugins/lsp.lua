return {
  "neovim/nvim-lspconfig",
  config = function()
    -- Avoid capturing every LSP stderr line as ERROR (a misbehaving
    -- server can otherwise balloon lsp.log to many GB).
    vim.lsp.log.set_level(vim.lsp.log.levels.WARN)
    vim.lsp.enable('ty')
    vim.lsp.inlay_hint.enable(false)
    -- Disable diagnostic signs (blue circles in signcolumn)
    vim.diagnostic.config({ signs = false })
  end,
}
