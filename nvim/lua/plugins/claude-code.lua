vim.keymap.set('n', '<leader>cc', '<cmd>ClaudeCode<CR>', { desc = 'Toggle Claude Code' })

return {
  "greggh/claude-code.nvim",
  dependencies = {
    "nvim-lua/plenary.nvim"
  },
  config = function()
    require("claude-code").setup({
      window = {
        position = "vertical",
        split_ratio = 0.3,
      },
      command = "ANTHROPIC_AUTH_TOKEN=llamacpp ANTHROPIC_BASE_URL=http://127.0.0.1:8012 claude",
    })
  end
}
