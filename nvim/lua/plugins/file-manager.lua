-- Ignore these files and directories
vim.g.NERDTreeIgnore = {
  "^__pycache__$",
  "^\\.mypy_cache$",
  "^\\.pytest_cache$",
  "^\\.git$",
  "^\\.DS_Store$",
}

-- Remaps
vim.keymap.set("n", "<c-n>", ":NERDTreeToggle<cr>")
vim.keymap.set("n", "<leader>n", ":NERDTreeFocus<cr>")

return {
  "preservim/nerdtree",
  config = function()
    -- Auto command group
    vim.api.nvim_create_augroup("NERDTreeGroup", {})

    -- Start NERDTree and put the cursor back in the other window
    vim.api.nvim_create_autocmd("VimEnter", {
      group = "NERDTreeGroup",
      pattern = "*",
      command = "silent NERDTree | wincmd p",
    })

    -- Exit Vim if NERDTree is the only window left.
    vim.api.nvim_create_autocmd("BufEnter", {
      group = "NERDTreeGroup",
      pattern = "*",
      command = "if tabpagenr('$') == 1 && winnr('$') == 1 && exists('b:NERDTree') && b:NERDTree.isTabTree() | quit | endif",
    })
  end,
}
