return {
  "nvim-telescope/telescope.nvim",
  dependencies = {
    { "nvim-lua/plenary.nvim" },
    { "BurntSushi/ripgrep" },
    {
      "nvim-tree/nvim-web-devicons",
      opts = {},
    },
    {
      "nvim-telescope/telescope-fzf-native.nvim",
      build = "cmake -S. -Bbuild -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release"
    },
  },
  config = function()
    local builtin = require('telescope.builtin')
    vim.keymap.set("n", "<leader>ff", builtin.git_files)
    vim.keymap.set("n", "<leader>fg", builtin.live_grep)
    vim.keymap.set("n", "<leader>fb", builtin.buffers)
    vim.keymap.set("n", "<leader>fh", builtin.help_tags)
  end,
}
