return {
  "yetone/avante.nvim",
  build = vim.fn.has("win32") ~= 0
      and "powershell -ExecutionPolicy Bypass -File Build.ps1 -BuildFromSource false"
      or "make",
  event = "VeryLazy",
  version = false,
  opts = {
    instructions_file = "avante.md",
    provider = "claude",
    providers = {
      alexandra = {
        __inherited_from = "openai",
        endpoint = "https://inference.projects.alexandrainst.dk/v1",
        model = "Qwen/Qwen3-Coder-30B-A3B-Instruct",  -- "synquid/gemma-3-27b-it-FP8",
        api_key_name = "INFERENCE_SERVER_API_KEY",
      },
      qwen3_coder = {
        __inherited_from = "ollama",
        model = "qwen3-coder:30b",
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
