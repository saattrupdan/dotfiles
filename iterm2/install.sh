#!/bin/sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
autolaunch="$HOME/Library/Application Support/iTerm2/Scripts/AutoLaunch"
source_script="$source_dir/sort_pi_tabs.py"
installed_script="$autolaunch/sort_pi_tabs.py"

if [ "${1:-}" = "--remove" ]; then
  if [ -L "$installed_script" ] && [ "$(readlink "$installed_script")" = "$source_script" ]; then
    rm "$installed_script"
  fi
  exit 0
fi

if [ "$#" -ne 0 ]; then
  printf 'Usage: %s [--remove]\n' "$0" >&2
  exit 2
fi

mkdir -p "$autolaunch"
if [ -e "$installed_script" ] || [ -L "$installed_script" ]; then
  if [ -L "$installed_script" ] && [ "$(readlink "$installed_script")" = "$source_script" ]; then
    exit 0
  fi
  printf 'Refusing to replace existing iTerm2 script: %s\n' "$installed_script" >&2
  exit 1
fi

ln -s "$source_script" "$installed_script"
