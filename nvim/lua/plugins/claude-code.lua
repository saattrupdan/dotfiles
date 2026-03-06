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
      command = "ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_BASE_URL=http://127.0.0.1:1234 claude --model qwen/qwen3.5-35b-a3b --tools default",
    })
  end
}
