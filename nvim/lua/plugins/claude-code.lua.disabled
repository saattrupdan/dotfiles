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
        split_ratio = 0.5,
      },
      command = "ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_BASE_URL=http://127.0.0.1:11434 claude --model gpt-oss:20b --tools default",
    })
  end
}
