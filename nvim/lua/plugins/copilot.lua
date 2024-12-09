vim.g.copilot_no_tab_map = true

local opts = { silent = true, noremap = true, expr = true, replace_keycodes = false }
vim.keymap.set("i", "§", 'copilot#Accept("$")', opts)

return { "github/copilot.vim" }
