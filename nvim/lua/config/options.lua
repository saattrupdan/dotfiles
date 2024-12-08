-- Disable swap files
vim.opt.swapfile = false

-- Set background scheme
vim.opt.background = dark
vim.opt.bg = dark

-- Disable bell
vim.opt.errorbells = false
vim.opt.visualbell = true

-- Automatically change the current working directory to the present file
vim.opt.autochdir = true

-- Enable absolute line numbering
vim.opt.number = true

-- Enable relative line numbering
vim.opt.relativenumber = true

-- Extra linting column
vim.opt.signcolumn = "yes"

-- Convert tabs into spaces
vim.opt.expandtab = true

-- Set default number of tab spaces
vim.opt.tabstop = 4
vim.opt.shiftwidth = 4

-- Enable auto-indent
vim.opt.ai = true

-- Offset lines when scrolling
vim.opt.scrolloff = 30

-- Faster update time, default is 4000 = 4s
vim.opt.updatetime = 50

-- Set the clipboard to be the standard clipboard
vim.opt.clipboard = "unnamed"

-- Disable automatic copying selected text
vim.opt.clipboard:remove "autoselect"

-- Tab size
vim.opt.tabstop = 2

-- Shift size, using > and < will move text by this value
vim.opt.shiftwidth = 2
