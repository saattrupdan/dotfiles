#!/usr/bin/env bash
#
# Link this directory's skills into a skill-discovery directory (by default
# ~/.pi/agent/skills) as symlinks. This repo is the ground truth: run this after
# adding, renaming, or removing a skill.
#
#   ./sync.sh                 create/repair links, drop dangling repo links
#   ./sync.sh --check         report drift only, exit 1 if anything is wrong
#   ./sync.sh --dry-run       print what would happen
#   ./sync.sh --adopt         also repoint links that currently point elsewhere
#   ./sync.sh --dest DIR      link somewhere else (or set PI_SKILLS_DIR)

set -euo pipefail

SRC=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
DEST=${PI_SKILLS_DIR:-"$HOME/.pi/agent/skills"}

DRY_RUN=0
CHECK_ONLY=0
ADOPT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1 ;;
    -c|--check)   CHECK_ONLY=1; DRY_RUN=1 ;;
    --adopt)      ADOPT=1 ;;
    --dest)       DEST=$2; shift ;;
    -h|--help)    sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)            printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

LINKS=()      # skill names in this repo to link into $DEST
BROKEN=()     # repo entries that are not a usable skill
STALE=()      # links in $DEST pointing at a removed repo entry
CONFLICTS=()  # $DEST entries that need a human decision

for path in "$SRC"/*; do
  name=$(basename "$path")
  if [[ -d "$path" ]]; then
    if [[ -f "$path/SKILL.md" ]]; then LINKS+=("$name"); else BROKEN+=("$name"); fi
  elif [[ -f "$path" && ! -L "$path" ]]; then
    : # a plain file in this directory (this script) — not a skill
  else
    BROKEN+=("$name")
  fi
done

in_links() {
  local want=$1 name
  for name in ${LINKS+"${LINKS[@]}"}; do
    [[ "$name" == "$want" ]] && return 0
  done
  return 1
}

absolute_link() { # echo a link's target as an absolute path ("" if unresolvable)
  local entry=$1 target
  target=$(readlink "$entry") || return 1
  case "$target" in
    /*) printf '%s\n' "${target%/}" ;;
    *)  printf '%s\n' "$(cd -- "$(dirname -- "$entry")/$(dirname -- "$target")" 2>/dev/null \
         && pwd -P)/$(basename -- "$target")" ;;
  esac
}

mkdir -p -- "$DEST"

for name in ${LINKS+"${LINKS[@]}"}; do
  entry="$DEST/$name"
  if [[ ! -e "$entry" && ! -L "$entry" ]]; then
    status=missing
  elif [[ -L "$entry" ]]; then
    target=$(absolute_link "$entry" || true)
    if [[ "$target" == "$SRC/$name" ]]; then
      [[ -e "$entry" ]] && status=correct || status=stale
    else
      real_src=$(realpath "$SRC/$name" 2>/dev/null || echo "")
      real_dest=$(realpath "$entry" 2>/dev/null || echo "")
      if [[ -n "$real_src" && "$real_src" == "$real_dest" ]]; then status=correct; else status=external; fi
    fi
  else
    status=dir
  fi

  case "$status" in
    correct) ;;
    missing)
      if [[ $CHECK_ONLY -eq 1 ]]; then CONFLICTS+=("$name: not linked into $DEST")
      elif [[ $DRY_RUN -eq 1 ]]; then printf 'link   %s -> %s/%s\n' "$DEST/$name" "$SRC" "$name"
      else ln -s "$SRC/$name" "$entry"; printf 'link   %s -> %s/%s\n' "$entry" "$SRC" "$name"; fi
      ;;
    stale)
      STALE+=("$name")
      ;;
    external)
      if [[ $ADOPT -eq 1 ]]; then
        if [[ $DRY_RUN -eq 1 ]]; then printf 'adopt  %s -> %s/%s\n' "$DEST/$name" "$SRC" "$name"
        else rm -- "$entry" && ln -s "$SRC/$name" "$entry"; printf 'adopt  %s -> %s/%s\n' "$entry" "$SRC" "$name"; fi
      else
        CONFLICTS+=("$name: $entry points outside this repo ($(readlink "$entry")) — use --adopt to replace it")
      fi
      ;;
    dir)
      CONFLICTS+=("$name: $entry is a real directory, not a link — move it away first")
      ;;
  esac
done

for entry in "$DEST"/*; do
  [[ -L "$entry" ]] || continue
  name=$(basename "$entry")
  in_links "$name" && continue
  target=$(absolute_link "$entry" || true)
  [[ "$target" == "$SRC/$name" ]] && STALE+=("$name")
done

for name in ${STALE+"${STALE[@]}"}; do
  entry="$DEST/$name"
  if [[ $CHECK_ONLY -eq 1 ]]; then CONFLICTS+=("$name: dangling link in $DEST, source no longer a skill")
  elif [[ $DRY_RUN -eq 1 ]]; then printf 'remove %s (no longer a skill in this repo)\n' "$entry"
  else rm -- "$entry"; printf 'remove %s (no longer a skill in this repo)\n' "$entry"; fi
done

for name in ${BROKEN+"${BROKEN[@]}"}; do
  CONFLICTS+=("agentic/skills/$name: not a readable skill directory (broken link inside the repo?)")
done

for msg in ${CONFLICTS+"${CONFLICTS[@]}"}; do
  printf 'CHECK  %s\n' "$msg" >&2
done

printf '%s: %d skill(s) in this repo, %d linked into %s\n' \
  "$(basename "$SRC")" "${#LINKS[@]}" "${#LINKS[@]}" "$DEST"

if [[ ${#CONFLICTS[@]} -gt 0 ]]; then exit 1; fi
exit 0
