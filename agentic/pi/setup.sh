#!/usr/bin/env bash
# Set up Pi on a fresh machine, end to end:
#   1. symlink the config into ~/.pi/agent (backing up any real files in the way)
#   2. create models.json by prompting for provider credentials (not committed to git)
#   3. use the existing Node, or bootstrap an LTS Node via nvm if none is found
#   4. ensure GNU Make >= 4.4 (building it if the system make is too old; needed
#      to compile the tree-sitter native modules)
#   5. wipe stale node_modules and install each extension's npm dependencies
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

  # A real directory here is intentional curation (e.g. a `skills` dir that
  # aggregates skills from several repos) — clobbering it into a repo-only
  # symlink would silently drop those. Leave it untouched; remove it yourself
  # if you want setup.sh to manage this link.
  if [ -d "$dest" ] && [ ! -L "$dest" ]; then
    echo "=== $name: real directory present — left as-is (not symlinked)"
    return
  fi

  # A real file (not a symlink) lives here — e.g. a config copied in manually.
  # Back it up to <name>.bak and replace it with the symlink.
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

# --- 2. models.json ---------------------------------------------------------
# Create models.json by prompting the user for provider credentials.
# This file contains secrets and is NOT committed to git.

echo "=== Setting up models.json ==="

# Skip if already exists (user may have custom config)
if [ -f "$PI_HOME/models.json" ]; then
  echo "models.json already exists at $PI_HOME/models.json — skipping"
else
  echo "models.json not found — creating new configuration"
  echo
  echo "Configure your LLM provider. Press Enter to keep the default value."
  echo

  read -rp "Base URL [http://127.0.0.1:8080/v1]: " base_url
  read -rp "API key [default]: " api_key
  read -rp "Model ID: " model_id
  read -rp "Context window [262144]: " context_window

  base_url="${base_url:-http://127.0.0.1:8080/v1}"
  api_key="${api_key:-default}"
  model_id="${model_id:-}"
  context_window="${context_window:-262144}"

  if [ -z "$model_id" ]; then
    echo "Error: Model ID is required"
    exit 1
  fi

  echo
  echo "Writing models.json..."

  # Build JSON file
  json_file="$PI_HOME/models.json"

  printf '{\n  "providers": {\n    "default": {\n' > "$json_file"
  printf '      "baseUrl": "%s",\n' "$base_url" >> "$json_file"
  printf '      "api": "openai-completions",\n' >> "$json_file"
  printf '      "apiKey": "%s",\n' "$api_key" >> "$json_file"
  printf '      "models": [{\n' >> "$json_file"
  printf '        "id": "%s",\n' "$model_id" >> "$json_file"
  printf '        "contextWindow": %s\n' "$context_window" >> "$json_file"
  printf '      }]\n' >> "$json_file"
  printf '    }\n' >> "$json_file"
  printf '  }\n' >> "$json_file"
  printf '}\n' >> "$json_file"

  echo "--- models.json created at $PI_HOME/models.json"
  echo
fi

echo

# --- 3. Node -----------------------------------------------------------------

# IMPORTANT: the native modules (better-sqlite3, tree-sitter) are node-gyp
# addons whose compiled binaries are ABI-LOCKED to a Node major
# (NODE_MODULE_VERSION) — they are NOT portable across versions. They must be
# built with the SAME Node that executes `pi`, or pi crashes at startup with
# "compiled against a different Node.js version".
#
# `pi`'s launcher is `#!/usr/bin/env node`, so pi runs under the first `node` on
# PATH at launch — on macOS that's Homebrew node@24, while an interactive shell
# often defaults to nvm's Node (lazy, not on PATH until sourced). Building with
# the wrong one is exactly what breaks pi. So we still only bootstrap an LTS Node
# via nvm when none exists at all, but then resolve the exact node pi will use
# (see resolve_pi_node below) and build with THAT — a shell that happens to have
# a different node active can no longer poison the build.
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

# Resolve the Node that will actually execute `pi`, and build native modules with
# it (see the note above). Priority: explicit $PI_NODE override > an absolute node
# hard-coded in pi's shebang > a non-nvm node matching `env node` when nvm isn't
# loaded (Homebrew/system) > whatever node exists (Linux/Spark: nvm's node is the
# real one pi uses too).
PI_BIN="$(command -v pi 2>/dev/null || true)"
resolve_pi_node() {
  if [ -n "${PI_NODE:-}" ] && command -v "$PI_NODE" >/dev/null 2>&1; then
    command -v "$PI_NODE"; return
  fi
  if [ -n "$PI_BIN" ]; then
    sb="$(head -1 "$PI_BIN" 2>/dev/null)"
    case "$sb" in
      "#!/"*/node) echo "${sb#\#!}"; return ;;   # absolute node in shebang
    esac
  fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  command -v node 2>/dev/null
}
PI_NODE="$(resolve_pi_node)"
if [ -z "$PI_NODE" ] || [ ! -x "$PI_NODE" ]; then
  echo "error: could not locate the Node that runs pi (set PI_NODE=/path/to/node)" >&2
  exit 1
fi
PI_NODE_BIN_DIR="$(cd "$(dirname "$PI_NODE")" && pwd)"
echo "Building native modules with pi's Node: $PI_NODE ($("$PI_NODE" -v), ABI $("$PI_NODE" -e 'process.stdout.write(process.versions.modules)'))"
echo

# --- 4. Build toolchain & GNU Make ------------------------------------------

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

# --- 5. Extension dependencies ----------------------------------------------

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

  echo "--- $name: npm $INSTALL_CMD (Node $("$PI_NODE" -v))"
  # Force pi's Node to the front of PATH so npm/node-gyp build against its ABI,
  # regardless of which node is otherwise active in this shell.
  if (cd "$dir" && PATH="$PI_NODE_BIN_DIR:$PATH" CXXFLAGS="--std=c++20" npm "$INSTALL_CMD" --legacy-peer-deps); then
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

# --- 6. Verify native modules load under pi's Node --------------------------
# An ABI mismatch otherwise stays silent until pi crashes at startup. Load every
# freshly built binding under pi's Node and fail loudly here if any was compiled
# against a different Node major.
echo
echo "Verifying native modules load under pi's Node ($("$PI_NODE" -v))…"
abi_bad=""
for nodefile in $(find "$EXT_DIR"/*/node_modules -name '*.node' -path '*/build/Release/*' 2>/dev/null); do
  err="$("$PI_NODE" -e 'try{require(process.argv[1])}catch(e){process.stderr.write(e.message)}' "$nodefile" 2>&1 >/dev/null)"
  case "$err" in
    *NODE_MODULE_VERSION*|*"different Node.js version"*)
      echo "!!! ABI mismatch: $nodefile" >&2
      abi_bad="yes" ;;
  esac
done
if [ -n "$abi_bad" ]; then
  echo "error: native modules were built against the wrong Node ABI — they must" >&2
  echo "       match pi's Node ($PI_NODE). Re-run with a correct PATH or set PI_NODE." >&2
  exit 1
fi
echo "All native modules load cleanly under pi's Node."
