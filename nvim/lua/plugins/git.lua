vim.g.merginal_remoteVisible = 0

-- Show current branch in lightline status bar
vim.g.lightline = {
  colorscheme = "one",
  active = {
    left = {
      { "mode", "paste" },
      { "gitbranch", "readonly", "filename", "modified" },
    },
  },
  component_function = { gitbranch = "fugitive#head" },
}

vim.keymap.set("n", "<leader>gs", ":Git<cr>")
vim.keymap.set("n", "<leader>gd", ":Gdiff<cr>")
vim.keymap.set("v", "<leader>dg", ":diffget<cr>")
vim.keymap.set("v", "<leader>dp", ":diffput<cr>")
vim.keymap.set("n", "<leader>gb", ":Merginal<cr>")

return {
  { "tpope/vim-fugitive" },
  { "idanarye/vim-merginal", dependencies = { "tpope/vim-fugitive" } },
  { "itchyny/lightline.vim", dependencies = { "tpope/vim-fugitive" } },
}
