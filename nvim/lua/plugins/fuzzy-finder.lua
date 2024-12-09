return {
  {
    "nvim-telescope/telescope.nvim",
    dependencies = { "nvim-lua/plenary.nvim" },
    config = function()
      builtin = require('telescope.builtin')
      vim.keymap.set("n", "<leader>ff", builtin.git_files)
      vim.keymap.set("n", "<leader>fg", builtin.live_grep)
      vim.keymap.set("n", "<leader>fb", builtin.buffers)
      vim.keymap.set("n", "<leader>fh", builtin.help_tags)
    end,
  },
  {
    "nvim-telescope/telescope-fzf-native.nvim",
    build = 'cmake -S. -Bbuild -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release'
  },
  {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    config = function ()
      local configs = require("nvim-treesitter.configs")
      configs.setup({
          ensure_installed = {
            "lua",
            "vim",
            "vimdoc",
            "javascript",
            "typescript",
            "html",
            "css",
            "vue",
            "python",
            "fsharp",
          },
          sync_install = false,
          highlight = { enable = true },
          indent = { enable = true },
        })
    end
  },
}
