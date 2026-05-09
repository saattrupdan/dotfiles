-- Set the `OPENCODE_DISABLE_PROJECT_CONFIG` to '1' to disable project configuration:
vim.env.OPENCODE_DISABLE_PROJECT_CONFIG = '1'

-- Enables websearch
vim.env.OPENCODE_ENABLE_EXA = '1'

return {
  "sudo-tee/opencode.nvim",
  config = function()
    require("opencode").setup({
      default_mode = 'orchestrator',
      preferred_picker = 'telescope',
      preferred_completion = 'coc',
      server = {
        timeout = 60,
      },
      ui = {
        position = 'float',
        output = {
          tools = {
            show_output = true,
            show_reasoning_output = false,
            use_folds = true,
            folding_threshold = 5,
          },
        },
      },
      context = {
        current_file = {
          enabled = false,
        },
        diagnostics = {
          info = false,
          warning = false,
          error = false,
        }
      },
      keymap = {
        editor = {
          ['<C-,>'] = { 'toggle' },
        },
        input_window = {
          ['<C-CR>'] = { 'submit_input_prompt', mode = { 'n', 'i' } },
          ['<tab>'] = { 'switch_mode', mode = { 'n', 'i' } },
        },
      },
    })
  end,
  dependencies = {
    "nvim-lua/plenary.nvim",
    {
      "MeanderingProgrammer/render-markdown.nvim",
      opts = {
        anti_conceal = { enabled = false },
        file_types = { 'opencode_output' },
      },
      ft = { 'Avante', 'copilot-chat', 'opencode_output' },
    },
    'nvim-telescope/telescope.nvim',
  },
}
