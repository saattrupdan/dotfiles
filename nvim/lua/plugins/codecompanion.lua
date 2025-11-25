-- Open the chat
vim.keymap.set('n', '<leader>cc', ':CodeCompanionChat<CR>')

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
        variables = {
          ["buffer"] = {
            opts = {
              default_params = 'pin'
            },
          },
        },
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
      -- },
    },
    opts = {
      log_level = "DEBUG"
    },
  },
}
