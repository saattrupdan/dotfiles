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
      command = "ANTHROPIC_AUTH_TOKEN=llamacpp ANTHROPIC_BASE_URL=http://127.0.0.1:8080 claude --model Qwen3.5-35B-A3B-Q4_K_M --tools default --dangerously-skip-permissions",
      keymaps = {
        toggle = {
          normal = "<C-,>",
          terminal = "<C-,>",
        },
      },
    })
  end
}
