vim.keymap.set('n', '<leader>cc', '<cmd>ClaudeCode<CR>')

return {
  "greggh/claude-code.nvim",
  dependencies = {
    "nvim-lua/plenary.nvim"
  },
  config = function()
    require("claude-code").setup({
      window = {
        position = "float",
      },
      command = "ANTHROPIC_AUTH_TOKEN=llamacpp ANTHROPIC_BASE_URL=http://127.0.0.1:8080 CLAUDE_CODE_ENABLE_TELEMETRY=0 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_ATTRIBUTION_HEADER=0 CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --model Qwen3.5-35B-A3B-Q4_K_M --tools default --dangerously-skip-permissions",
      keymaps = {
        toggle = {
          normal = "<C-,>",
          terminal = "<C-,>",
        },
        window_navigation = false,
        scrolling = false,
      },
    })
  end
}
