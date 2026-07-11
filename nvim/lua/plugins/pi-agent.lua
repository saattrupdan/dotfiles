return {
  -- Local fork of pi-agent.nvim with fix for split pane session discovery race condition
  {
    dir = vim.fn.expand("~/gitsky/dotfiles/nvim"),
    name = "pi-agent.nvim",
    config = function()
      require("pi-agent").setup()
    end,
  },
}
