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
      command = "CLAUDE_CODE_ENABLE_TELEMETRY=0 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_ATTRIBUTION_HEADER=0 CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --tools default --dangerously-skip-permissions",
      keymaps = {
        toggle = {
          normal = "<C-.>",
          terminal = "<C-.>",
        },
        window_navigation = false,
        scrolling = false,
      },
    })
  end
}
