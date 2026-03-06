-- Open the chat with <leader>cc
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
    rules = {
      python = {
        description = "Python conventions",
        files = {
          "~/gitsky/dotfiles/AGENTS.md",
        },
      },
      opts = {
        chat = {
          autoload = "python",
        },
      },
    },
    adapters = {
      http = {
        ["llama.cpp"] = function()
          return require("codecompanion.adapters").extend("openai_compatible", {
            env = {
              url = "http://localhost:1234",
              model = "openai/gpt-oss-20b",
              api_key = "TERM",
            },
          })
        end,
      },
    },
    interactions = {
      chat = {
        adapter = "llama.cpp",
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
      inline = {
        adapter = "llama.cpp",
      },
      cmd = {
        adapter = "llama.cpp",
      },
      background = {
        adapter = "llama.cpp",
      },
    },
  },
}
