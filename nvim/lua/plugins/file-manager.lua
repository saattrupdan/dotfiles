-- Remaps
vim.keymap.set("n", "<c-n>", ":NvimTreeToggle<cr>")
vim.keymap.set("n", "<leader>n", ":NvimTreeFocus<cr>")

vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1

vim.opt.termguicolors = true

return {
  "nvim-tree/nvim-tree.lua",
  version = "*",
  lazy = false,
  requires = {
    "nvim-tree/nvim-web-devicons"
  },
  config = function()
    require("nvim-tree").setup({
      git = {
        enable = true,
        ignore = true,
      },
      filters = {
        dotfiles = false,
        custom = { "^.git$" },
      },
      renderer = {
        icons = {
          show = {
            file = true,
            folder = false,
            folder_arrow = true,
            git = false,
          },
        },
      },
      actions = {
        open_file = {
          window_picker = {
            enable = false,
          },
        },
      },
    })

    local api = require("nvim-tree.api")
    local view = require("nvim-tree.view")

    -- Auto open NvimTree on startup
    vim.api.nvim_create_autocmd("VimEnter", {
      callback = function()
        api.tree.open()
        vim.cmd("wincmd p")
      end
    })

    -- Close Neovim if NvimTree is the only window
    vim.api.nvim_create_autocmd("BufEnter", {
      callback = function()
        if view.is_visible() and #vim.api.nvim_list_wins() == 1 then
          vim.cmd("quit")
        end
      end
    })
  end,
}
