return {
  "yetone/avante.nvim",
  build = vim.fn.has("win32") ~= 0
      and "powershell -ExecutionPolicy Bypass -File Build.ps1 -BuildFromSource false"
      or "make",
  event = "VeryLazy",
  version = false,
  opts = {
    instructions_file = "~/gitsky/dotfiles/avante.md",
    provider = "claude_sonnet",
    providers = {
      claude_sonnet = {
        __inherited_from = "claude",
        model = "claude-sonnet-4-5-20250929",
        api_key_name = "AVANTE_ANTHROPIC_API_KEY",
      },
      alexandra = {
        __inherited_from = "openai",
        endpoint = "https://inference.projects.alexandrainst.dk/v1",
        model = "synquid/gemma-3-27b-it-FP8",
        api_key_name = "INFERENCE_SERVER_API_KEY",
        extra_request_body = {
          max_tokens = 8192,
        },
      },
      qwen3 = {
        __inherited_from = "ollama",
        model = "qwen3:4b-instruct-2507-q8_0",
        use_ReAct_prompt = true,
        extra_request_body = {
          options = {
            stream = true,
            temperature = 0.6,
            num_ctx = 40960,
            num_predict = -1,
          },
        },
        is_env_set = function()
          return true
        end,
      },
    },
  },
  dependencies = {
    "nvim-lua/plenary.nvim",
    "MunifTanjim/nui.nvim",
  },
}
