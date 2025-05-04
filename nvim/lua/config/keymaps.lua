-- Map § to $ to enable easier navigation
vim.keymap.set('n', '§', '$')
vim.keymap.set('v', '§', '$')

-- Always copy into the standard clipboard register
vim.keymap.set('v', 'y', '"+y')

-- Disable copying when deleting with 'd'
vim.keymap.set('n', 'd', '"_d')
vim.keymap.set('v', 'd', '"_d')

-- Set 'p' to paste into selection without copying the previous content
vim.keymap.set('v', 'p', '"_dP')

-- Open terminal in vim
vim.keymap.set('n', '<leader>t', ':bot vert term<cr>')

-- Reload all buffers
vim.keymap.set('n', '<leader>e', ':bufdo e!<cr>')

-- Wrap text
vim.keymap.set('n', '<leader><cr>', 'gwgw')
vim.keymap.set('v', '<leader><cr>', 'gw<cr>')

-- Switch from Terminal mode to Normal mode
vim.keymap.set('t', '<esc>', '<C-\\><C-n>')

-- Breakpoints in Python
vim.keymap.set("n", "<leader><leader>", "obreakpoint()<esc>:w<cr>")
vim.keymap.set("i", "<c-b>", "breakpoint()<esc>:w<cr>")
vim.keymap.set("v", "<leader><leader>", ':s/\\n/<temp>/g<CR>:s/\\( *\\)\\([^ ].*\\)/\1try:\r\1    \2\r\1except:\r\1    breakpoint()\r<CR><esc>:nohlsearch<CR>kkk:s/<temp>/\r    /g<cr>ddjj:w<cr>')
