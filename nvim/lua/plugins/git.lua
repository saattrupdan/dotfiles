vim.g.merginal_remoteVisible = 0

vim.keymap.set("n", "<leader>gs", ":Git<cr>")
vim.keymap.set("n", "<leader>gd", ":Gdiff<cr>")
vim.keymap.set("v", "<leader>dg", ":diffget<cr>")
vim.keymap.set("v", "<leader>dp", ":diffput<cr>")
vim.keymap.set("n", "<leader>gb", ":Merginal<cr>")

return {
  { "tpope/vim-fugitive" },
  { "idanarye/vim-merginal", dependencies = { "tpope/vim-fugitive" } },
}
