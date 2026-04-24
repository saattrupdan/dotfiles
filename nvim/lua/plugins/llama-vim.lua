return {
  "ggml-org/llama.vim",
  init = function()
    vim.g.llama_config = {
      show_info = false,

      endpoint_fim = "http://localhost:8080/infill",
      model_fim = "qwen2.5-coder-3b",

      endpoint_inst = "http://localhost:8080/v1/chat/completions",
      model_inst = "qwen3.6-35B-A3B-no-thinking",

      keymap_fim_accept_full = "§",
      keymap_fim_accept_line = "±",
      keymap_inst_trigger = "<leader>i",
      keymap_inst_accept = "<leader>a",

      -- These are the original keymaps. They got changed to a <leader> keymap, which
      -- causes an annoying delay every time <leader> is pressed in insert mode, so we
      -- just revert back the original keymaps.
      keymap_fim_trigger = "<C-F>",
      keymap_fim_accept_word = "<C-B>",
    }
  end,
}
