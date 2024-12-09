vim.api.nvim_create_augroup("SnowGroup", {})

vim.api.nvim_create_autocmd("BufEnter", {
  group = "SnowGroup",
  pattern = "*.py",
  callback = function()
    local snow = require("let-it-snow.snow")
    buf = vim.api.nvim_get_current_buf()
    if not snow.running[buf] then
      snow._let_it_snow()
    end
  end
})

vim.api.nvim_create_autocmd("BufLeave", {
  group = "SnowGroup",
  pattern = "*.py",
  callback = function()
    local snow = require("let-it-snow.snow")
    buf = vim.api.nvim_get_current_buf()
    if snow.running[buf] then
      snow.running[buf] = nil
    end
  end
})

return {
  "marcussimonsen/let-it-snow.nvim",
  opts = { delay = 300 },
}
