#!/usr/bin/env bash
# Set up Pi on a fresh machine, end to end:
#   1. symlink the config into ~/.pi/agent (backing up any real files in the way)
#   2. use the existing Node, or bootstrap an LTS Node via nvm if none is found
#   3. ensure GNU Make >= 4.4 (building it if the system make is too old; needed
#      to compile the tree-sitter native modules)
#   4. wipe stale node_modules and install each extension's npm dependencies
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
#   ~/.pi/agent/themes          -> agentic/pi/themes
#
# Dependencies: each extension declares its own npm deps in a per-extension
# package.json, but node_modules/ is gitignored — so a fresh copy has the code
# but none of the installed packages. This installs them in every extension
# dir that has a package.json.
#
# Some extensions (read, search, _outliner) use native modules (better-sqlite3,
# tree-sitter). Node.js 25+ requires C++20 for native builds, so CXXFLAGS is set
# accordingly. build-essential + python3 are installed as a compile fallback on apt.
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
link themes           "$SCRIPT_DIR/themes"
echo

# --- 2. Node -----------------------------------------------------------------

# The native modules (better-sqlite3, tree-sitter) are N-API, so the built
# binaries are ABI-stable and run under any Node major — we don't care which
# Node version is used, only that one exists. So leave whatever Node is already
# installed alone (switching it risks orphaning a global `pi`), and only
# bootstrap an LTS Node via nvm when none is present at all.
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
export NVM_DIR

if ! command -v node >/dev/null 2>&1; then
  echo "Node not found — installing LTS via nvm"
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
  nvm alias default 'lts/*'
  set -eu

  if ! command -v node >/dev/null 2>&1; then
    echo "error: nvm failed to provide Node — see output above" >&2
    exit 1
  fi
fi
echo "Using Node $(node -v)"
echo

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm still not on PATH after Node setup" >&2
  exit 1
fi

# --- 3. Build toolchain & GNU Make ------------------------------------------

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

# node-gyp needs GNU Make >= 4.4 to build the tree-sitter modules. Make 4.3
# (Ubuntu 24.04's default) has a target-matching regression that breaks on the
# node-addon-api ".stamp" path node-gyp emits (Release/obj.target/../...stamp),
# so the compile dies with "No rule to make target". When the system make is
# too old, build 4.4.1 once and point node-gyp at it via $MAKE.
make_lt_44() {
  v="$(make --version 2>/dev/null | head -1 | awk '{print $NF}')"   # e.g. 4.3 / 4.4.1
  mj="${v%%.*}"; r="${v#*.}"; mn="${r%%.*}"
  [ -z "$mj" ] && return 0
  [ "$mj" -gt 4 ] 2>/dev/null && return 1
  [ "$mj" -eq 4 ] 2>/dev/null && [ "${mn:-0}" -ge 4 ] 2>/dev/null && return 1
  return 0
}

if make_lt_44; then
  MAKE_PREFIX="$HOME/.cache/pi-setup/make-4.4.1"
  if [ ! -x "$MAKE_PREFIX/bin/make" ]; then
    echo "System make is < 4.4 ($(make --version 2>/dev/null | head -1)) — building GNU Make 4.4.1"
    if ! command -v curl >/dev/null 2>&1; then
      echo "error: curl needed to fetch GNU Make sources" >&2
      exit 1
    fi
    build_tmp="$(mktemp -d)"
    (
      cd "$build_tmp" &&
      curl -fsSLO https://ftpmirror.gnu.org/make/make-4.4.1.tar.gz &&
      tar xf make-4.4.1.tar.gz &&
      cd make-4.4.1 &&
      ./configure --prefix="$MAKE_PREFIX" >/dev/null &&
      make -j"$(nproc 2>/dev/null || echo 2)" >/dev/null &&
      make install >/dev/null
    ) || { echo "error: failed to build GNU Make 4.4.1" >&2; rm -rf "$build_tmp"; exit 1; }
    rm -rf "$build_tmp"
  fi
  MAKE="$MAKE_PREFIX/bin/make"
  export MAKE   # node-gyp honours $MAKE
  echo "Using $("$MAKE" --version | head -1) for native builds ($MAKE)"
  echo
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

  # Wipe any node_modules first for a clean, reproducible install (clears any
  # half-built or wrong-arch native modules left by a previous failed run).
  rm -rf "$dir/node_modules"

  echo "--- $name: npm $INSTALL_CMD"
  if (cd "$dir" && CXXFLAGS="--std=c++20" npm "$INSTALL_CMD"); then
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
  echo "Native modules failed to build. Check you're on LTS Node ($(node -v)), that" >&2
  echo "build-essential + python3 are installed, and GNU Make >= 4.4, then re-run." >&2
  exit 1
fi
