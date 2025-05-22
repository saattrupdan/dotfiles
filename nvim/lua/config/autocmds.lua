function RemoveTrailingWhitespace()
  local currentline = vim.api.nvim_call_function("line", {"."})
  vim.api.nvim_command("%s/\\s\\+$//e")
  if vim.api.nvim_call_function("line", {"."}) ~= currentline then
    vim.api.nvim_command(":execute \"normal 1\\<c-o>\"")
  end
end

-- Auto command group
vim.api.nvim_create_augroup("BasicGroup", { clear = true })

-- Remove trailing whitespace everytime :w is called
vim.api.nvim_create_autocmd("BufWritePre", {
  group = "BasicGroup",
  pattern = "*",
  callback = function()
    RemoveTrailingWhitespace()
  end
})

-- Set tab size depending on filetype
vim.api.nvim_create_autocmd("FileType", {
  group = "BasicGroup",
  pattern = "python",
  command = "set tabstop=4 | set shiftwidth=4",
})
