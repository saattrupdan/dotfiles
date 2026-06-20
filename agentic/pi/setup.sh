#!/usr/bin/env bash
# Set up Pi extension dependencies on a fresh machine.
#
# Each extension declares its own npm deps in a per-extension package.json,
# but node_modules/ is gitignored — so a freshly-cloned/copied config has the
# code but none of the installed packages. This installs them in every
# extension dir that has a package.json.
#
# Some extensions (read, search, _outliner) use native modules
# (better-sqlite3, tree-sitter) that compile on install and need a C/C++
# toolchain + python3. On Debian/Ubuntu: sudo apt-get install -y build-essential python3
#
# Usage: ./setup.sh [--ci]
#   --ci   use `npm ci` (clean, lockfile-exact) instead of `npm install`

set -euo pipefail

# Resolve the extensions dir relative to this script, following symlinks.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
EXT_DIR="$SCRIPT_DIR/extensions"

INSTALL_CMD="install"
if [ "${1:-}" = "--ci" ]; then
  INSTALL_CMD="ci"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm not found on PATH — install Node.js first" >&2
  exit 1
fi

if [ ! -d "$EXT_DIR" ]; then
  echo "error: extensions dir not found at $EXT_DIR" >&2
  exit 1
fi

echo "Installing Pi extension dependencies in $EXT_DIR"
echo

failed=()
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

  echo "--- $name: npm $INSTALL_CMD"
  if (cd "$dir" && npm "$INSTALL_CMD"); then
    installed=$((installed + 1))
  else
    echo "!!! $name: install failed" >&2
    failed+=("$name")
  fi
  echo
done

echo "Done: $installed extension(s) installed."
if [ ${#failed[@]} -gt 0 ]; then
  echo "Failed: ${failed[*]}" >&2
  echo "Native modules (better-sqlite3, tree-sitter) need a build toolchain — on Debian/Ubuntu try:" >&2
  echo "  sudo apt-get install -y build-essential python3" >&2
  exit 1
fi
