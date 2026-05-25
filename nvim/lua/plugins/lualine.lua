return {
  'nvim-lualine/lualine.nvim',
  dependencies = { 'nvim-tree/nvim-web-devicons' },
  config = function()
    -- Only add the opencode statusline component if the plugin is installed.
    local lualine_z = {}
    local ok, opencode = pcall(require, 'opencode')
    if ok then
      table.insert(lualine_z, opencode.statusline)
    end
    require('lualine').setup({
      sections = {
        lualine_z = lualine_z,
      }
    })
  end,
}
