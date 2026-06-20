#!/usr/bin/env bash
# Set up Pi on a fresh machine, end to end:
#   1. symlink the config into ~/.pi/agent (backing up any real files in the way)
#   2. ensure an LTS Node via nvm (installing nvm/Node if needed)
#   3. wipe stale node_modules and install each extension's npm dependencies
# Idempotent — safe to re-run.
#
# Symlinks (into this dotfiles repo, so edits stay version-controlled):
#   ~/.pi/agent/agents          -> agentic/pi/agents
#   ~/.pi/agent/extensions      -> agentic/pi/extensions
#   ~/.pi/agent/prompts         -> agentic/pi/prompts
#   ~/.pi/agent/settings.json   -> agentic/pi/settings.json
#   ~/.pi/agent/keybindings.json-> agentic/pi/keybindings.json
#   ~/.pi/agent/SYSTEM.md       -> agentic/pi/SYSTEM.md
#   ~/.pi/agent/skills          -> agentic/skills
#
# Dependencies: each extension declares its own npm deps in a per-extension
# package.json, but node_modules/ is gitignored — so a fresh copy has the code
# but none of the installed packages. This installs them in every extension
# dir that has a package.json.
#
# Some extensions (read, search, _outliner) use native modules (better-sqlite3,
# tree-sitter). These have prebuilt binaries for LTS Node, so the script pins to
# LTS; build-essential + python3 are installed as a compile fallback on apt.
#
# Usage: ./setup.sh [--ci]
#   --ci   use `npm ci` (clean, lockfile-exact) instead of `npm install`
#
# If a real file/dir is in the way of a symlink (e.g. configs copied in
# manually), it's backed up to <name>.bak and replaced with the symlink.

set -eu

# Resolve this script's dir (= agentic/pi), following symlinks. POSIX-safe:
# uses $0, so this works whether invoked as `./setup.sh`, `bash setup.sh`,
# or `sh setup.sh`.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
REPO_AGENTIC="$(cd "$SCRIPT_DIR/.." && pwd)"   # agentic/
EXT_DIR="$SCRIPT_DIR/extensions"
PI_HOME="$HOME/.pi/agent"

INSTALL_CMD="install"
for arg in "$@"; do
  case "$arg" in
    --ci) INSTALL_CMD="ci" ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# --- 1. Symlinks ------------------------------------------------------------

# "link_name -> target" pairs, relative to PI_HOME / the repo respectively.
link() {
  local name="$1" target="$2"
  local dest="$PI_HOME/$name"

  if [ ! -e "$target" ]; then
    echo "!!! $name: target missing ($target), skipping" >&2
    return
  fi

  # Already the correct symlink? Leave it.
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$target" ]; then
    echo "=== $name: already linked"
    return
  fi

  # A real file/dir (not a symlink) lives here — e.g. configs copied in
  # manually. Back it up to <name>.bak and replace it with the symlink.
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    backup="$dest.bak"
    i=1
    while [ -e "$backup" ]; do backup="$dest.bak.$i"; i=$((i + 1)); done
    mv "$dest" "$backup"
    echo "    backed up existing $name -> $backup"
  fi

  ln -sfn "$target" "$dest"
  echo "--- $name -> $target"
}

echo "Linking Pi config into $PI_HOME"
mkdir -p "$PI_HOME"
link agents           "$SCRIPT_DIR/agents"
link extensions       "$SCRIPT_DIR/extensions"
link prompts          "$SCRIPT_DIR/prompts"
link settings.json    "$SCRIPT_DIR/settings.json"
link keybindings.json "$SCRIPT_DIR/keybindings.json"
link SYSTEM.md        "$SCRIPT_DIR/SYSTEM.md"
link skills           "$REPO_AGENTIC/skills"
echo

# --- 2. Node (LTS) -----------------------------------------------------------

# Native modules (better-sqlite3, tree-sitter) ship prebuilt binaries only for
# LTS (even-numbered) Node releases. On an odd/non-LTS Node, prebuild-install
# misses and falls back to compiling old tree-sitter binding.gyp from source,
# which fails. So ensure an LTS Node (via nvm) whenever the current one isn't.
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
export NVM_DIR

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

cur_major="$(node_major)"
if [ "$cur_major" -eq 0 ] || [ "$((cur_major % 2))" -eq 1 ]; then
  if [ "$cur_major" -eq 0 ]; then
    echo "Node not found — installing LTS via nvm"
  else
    echo "Node v$cur_major is non-LTS (no native prebuilds) — switching to LTS via nvm"
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "error: curl needed to install nvm/Node — install curl, then re-run" >&2
    exit 1
  fi
  # nvm.sh and the nvm functions aren't written for `set -eu`, so relax it
  # while we drive nvm, then restore.
  set +eu
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "Installing nvm into $NVM_DIR…"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm use --lts
  nvm alias default 'lts/*'   # so `pi` later runs under the same LTS Node
  set -eu

  if ! command -v node >/dev/null 2>&1; then
    echo "error: nvm failed to provide Node — see output above" >&2
    exit 1
  fi
  echo "Now using Node $(node -v)"
  echo
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm still not on PATH after Node setup" >&2
  exit 1
fi

# --- 3. Extension dependencies ----------------------------------------------

# Native modules (better-sqlite3, tree-sitter) compile on install and need a
# C/C++ toolchain + python3. On apt-based systems, install them if missing.
need_toolchain=false
command -v cc  >/dev/null 2>&1 || need_toolchain=true
command -v make >/dev/null 2>&1 || need_toolchain=true
command -v python3 >/dev/null 2>&1 || need_toolchain=true

if [ "$need_toolchain" = true ]; then
  if command -v apt-get >/dev/null 2>&1; then
    echo "Build toolchain missing — installing build-essential python3"
    sudo apt-get update && sudo apt-get install -y build-essential python3
    echo
  else
    echo "!!! build toolchain (cc/make/python3) missing and apt-get not found." >&2
    echo "    Install a C/C++ compiler + python3 manually if native modules fail." >&2
    echo
  fi
fi

echo "Installing extension dependencies in $EXT_DIR"
echo

failed=""
installed=0

for pkg in "$EXT_DIR"/*/package.json; do
  [ -e "$pkg" ] || continue
  dir="$(dirname "$pkg")"
  name="$(basename "$dir")"

  # Skip extensions with no declared dependencies.
  if ! grep -q '"dependencies"\|"devDependencies"' "$pkg"; then
    echo "--- $name: no deps, skipping"
    continue
  fi

  # Wipe any node_modules first — a switch in Node version leaves native
  # modules built for the wrong ABI, which won't load at runtime.
  rm -rf "$dir/node_modules"

  echo "--- $name: npm $INSTALL_CMD"
  if (cd "$dir" && npm "$INSTALL_CMD"); then
    installed=$((installed + 1))
  else
    echo "!!! $name: install failed" >&2
    failed="$failed $name"
  fi
  echo
done

echo "Done: $installed extension(s) installed."
if [ -n "$failed" ]; then
  echo "Failed:$failed" >&2
  echo "Native modules failed to build. Check you're on LTS Node ($(node -v)) and" >&2
  echo "that build-essential + python3 are installed, then re-run." >&2
  exit 1
fi
