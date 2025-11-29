return {
  "neovim/nvim-lspconfig",
  dependencies = {
    "mason-org/mason.nvim",
    "mason-org/mason-lspconfig.nvim",
  },
  build = ":MasonInstall pyrefly",
  config = function()
    require("mason").setup()
    require("mason-lspconfig").setup {
      ensure_installed = { "pyrefly" },
    }
    vim.lsp.enable({"pyrefly"})
    vim.lsp.inlay_hint.enable(false)
  end,
}
