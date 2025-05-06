local opts = {
  -- highlight = { enable = true },
  indent = { enable = true },
  ensure_installed = {
    "bash",
    "html",
    "javascript",
    "json",
    "lua",
    "markdown",
    "markdown_inline",
    "python",
    "regex",
    "toml",
    "typescript",
    "vim",
    "vimdoc",
    "yaml",
    "latex",
  },
}

local function config()
  require("nvim-treesitter.configs").setup(opts)
end

return {
  "nvim-treesitter/nvim-treesitter",
  build = ":TSUpdate",
  config = config,
}
