-- Equivalent lua to vimscript:
-- function RemoveTrailingWhitespace()
--     let currentline=line(".")
--     %s/\s\+$//e
--     if line(".") != currentline
--         :execute "normal 1\<c-o>"
--     endif
-- endfunction
function RemoveTrailingWhitespace()
    print("Removing trailing whitespace")
    local currentline = vim.api.nvim_call_function("line", {"."})
    vim.api.nvim_command("%s/\\s\\+$//e")
    if vim.api.nvim_call_function("line", {"."}) ~= currentline then
        vim.api.nvim_command(":execute \"normal 1\\<c-o>\"")
    end
end


-- Auto command group
vim.api.nvim_create_augroup("BasicGroup", {})

-- Remove trailing whitespace everytime :w is called
vim.api.nvim_create_autocmd("BufWritePre", {
    group = "BasicGroup",
    pattern = "*",
    callback = function()
        RemoveTrailingWhitespace()
    end
})

-- Line length
vim.api.nvim_create_autocmd({"BufRead", "BufNewFile"}, {
    group = "BasicGroup",
    pattern = "*",
    command = "set textwidth=88 | set wrapmargin=88 | set colorcolumn=89",
})

-- Set tab size depending on filetype
vim.api.nvim_create_autocmd("FileType", {
    group = "BasicGroup",
    pattern = "*.py",
    command = "set tabstop=4",
})

-- Set shift size using > and < depending on filetype
vim.api.nvim_create_autocmd("FileType", {
    group = "BasicGroup",
    pattern = "python",
    command = "set shiftwidth=4",
})
