return {
  -- Local fork of pi-agent.nvim with fix for split pane session discovery race condition
  "nvim/lua/pi-agent",
  config = function()
    -- Pi session warning behavior: pi-agent.nvim generates a fresh unique session ID
    -- for every new pi-agent session/pane in Neovim (format: nvim-{timestamp}-{hrtime}-{counter}-{random}),
    -- passed to pi via `--session-id`. On first run, Pi warns "No project session found
    -- with id ..." — this is expected; the warning is informational (session is created).
    -- This is a UX quirk in upstream Pi: the message should be info-level, not a warning.
    require("pi-agent").setup()
  end,
}
