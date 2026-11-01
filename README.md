# Dotfiles

Collection of my dotfiles. I use this repo mainly as a way to sync these files between
my devices, but they may serve as inspiration to others as well.

## iTerm2 Pi tab ordering

`iterm2/sort_pi_tabs.py` sorts tabs within each ungrouped iTerm2 window:
**Need input / Error**, **Finished**, **Working / Starting**, **Idle**, then
non-Pi tabs. Tabs in the same tier retain their current order. It uses the
expiring `user.pi_agent_sort_status` variable published only by Pi sessions
launched through `pi-agent.nvim`; ordinary Neovim tabs remain non-Pi. Grouped
windows are left unchanged to preserve their tab groups.

Enable **iTerm2 > Settings > General > Magic > Enable Python API** and run
`sh iterm2/install.sh` from this repository. The installer links the script
into iTerm2's `Scripts/AutoLaunch` directory; iTerm2 starts it on its next
launch. To start it without restarting iTerm2, run:

```sh
/Applications/iTerm.app/Contents/Resources/it2run \
  "$HOME/Library/Application Support/iTerm2/Scripts/AutoLaunch/sort_pi_tabs.py"
```

Check it with `uv run --directory iterm2 pytest -q`,
`uv run --directory iterm2 ruff check .`, and
`uv run --directory iterm2 ty check .`. To stop future launches, run
`sh iterm2/install.sh --remove`; stop an already running instance through
**iTerm2 > Scripts > Manage**. Removing it does not restore earlier tab
positions.
