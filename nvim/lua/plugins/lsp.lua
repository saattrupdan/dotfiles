return {
  "neovim/nvim-lspconfig",
  config = function()
    -- Avoid capturing every LSP stderr line as ERROR (a misbehaving
    -- server can otherwise balloon lsp.log to many GB).
    vim.lsp.log.set_level(vim.lsp.log.levels.WARN)
    -- Python comes from coc (coc-ty), which also drives the completion popup.
    -- Enabling a native client here starts a second `ty server` over the same
    -- files and only duplicates diagnostics.
    vim.lsp.inlay_hint.enable(false)
    -- Disable diagnostic signs (blue circles in signcolumn)
    vim.diagnostic.config({ signs = false })
  end,
}
