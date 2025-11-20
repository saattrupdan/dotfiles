local opts = { silent = true, noremap = true, expr = true, replace_keycodes = false }

-- Coc autocompletion
vim.keymap.set("i", "<tab>", 'coc#pum#visible() ? coc#pum#confirm() : "<tab>"', opts)
vim.keymap.set("i", "<esc>", 'coc#pum#visible() ? "<c-r>=coc#pum#cancel()<cr><esc>" : "<esc>"', opts)
vim.keymap.set("i", "J", 'coc#pum#visible() ? coc#pum#next(0) : "J"', opts)
vim.keymap.set("i", "K", 'coc#pum#visible() ? coc#pum#prev(0) : "K"', opts)

-- Coc tooltip scrolling
vim.keymap.set("i", "<c-j>", 'coc#float#has_scroll() ? "<c-r>=coc#float#scroll(1)<cr>" : "<c-j>"', opts)
vim.keymap.set("i", "<c-k>", 'coc#float#has_scroll() ? "<c-r>=coc#float#scroll(0)<cr>" : "<c-k>"', opts)

return {
  "neoclide/coc.nvim",
  branch = "release",
  build = "yarn install --frozen-lockfile",
  config = function()
    vim.g.coc_global_extensions = {
      "coc-json",
      "coc-rust-analyzer",
      "@yaegassy/coc-volar",
      "coc-tsserver",
      "coc-lua",
    }
  end,
}
