return {
  "Juksuu/worktrees.nvim",
  dependencies = {
    "nvim-lua/plenary.nvim",
    "nvim-telescope/telescope.nvim",
  },
  opts = {},
  config = function(_, opts)
    require("worktrees").setup(opts)
    require("telescope").load_extension("worktrees")
  end,
  keys = {
    {
      "<leader>fw",
      function()
        require("telescope").extensions.worktrees.list_worktrees()
      end,
      desc = "Find worktrees",
    },
  },
}
