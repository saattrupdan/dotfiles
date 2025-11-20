return {
  "neovim/nvim-lspconfig",
  dependencies = {
    "mason-org/mason.nvim",
    "mason-org/mason-lspconfig.nvim",
  },
  opts = {
    inlay_hints = {
      enabled = false,
    },
  },
  config = function()
    require("mason").setup()
    require("mason-lspconfig").setup {
      ensure_installed = {
        "pyrefly"
      },
    }
    vim.lsp.enable({"pyrefly"})
  end,
}
