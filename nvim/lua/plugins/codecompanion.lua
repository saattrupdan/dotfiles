-- Open the chat
vim.keymap.set('n', '<leader>cc', ':CodeCompanionChat<CR>')

-- Expand 'cc' into 'CodeCompanion' in the command line
vim.cmd([[cab cc CodeCompanion]])

return {
  "olimorris/codecompanion.nvim",
  dependencies = {
    { "nvim-lua/plenary.nvim" },
    { "neoclide/coc.nvim" },
    { "nvim-treesitter/nvim-treesitter", build = ":TSUpdate" },
  },
  opts = {
    display = {
      chat = {
        window = {
          position = "right",
          width = 88,
        },
      },
    },
    memory = {
      opts = {
        chat = {
          enabled = true,
        },
      },
    },
    strategies = {
      chat = {
        -- adapter = "ollama",
        -- model = "qwen3-coder:30b",
        -- num_ctx = 256000,
        tools = {
          opts = {
            auto_submit_errors = true,
            auto_submit_success = true,
            default_tools = {
              "full_stack_dev",
            },
          },
        },
        opts = {
          completion_provider = "coc",
        },
      },
      -- inline = {
      --   adapter = "ollama",
      --   model = "qwen3-coder:30b",
      --   num_ctx = 256000,
      -- },
    },
    opts = {
      log_level = "DEBUG"
    },
  },
}
