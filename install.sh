#!/usr/bin/env bash
# Install every plugin listed in .bb/plugins.json from this checkout.
# Usage: ./install.sh            install all
#        ./install.sh kanban     install one
# A plugin already installed from a git/npm source is removed first, since bb
# refuses to change the source of an installed id (this drops its settings). A
# plugin already installed from another local path is moved and keeps settings.
set -euo pipefail
cd "$(dirname "$0")"
REPO=$PWD

names() {
  if [ $# -gt 0 ]; then printf '%s\n' "$@"; return; fi
  sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' .bb/plugins.json | grep -v '^dwang-bb-plugins$'
}

installed_source() {
  bb plugin source "$1" 2>/dev/null | sed -n 's/^ *requested: *//p'
}

for name in $(names "$@"); do
  have=$(installed_source "$name" || true)
  # bb records a path install as the plugin's own directory under this repo.
  case "$have" in "path:$REPO"|"path:$REPO/"*) have_ok=1 ;; path:*) have_ok=move ;; *) have_ok=0 ;; esac
  if [ -n "$have" ] && [ "$have_ok" = 0 ]; then
    echo "== $name: replacing $have"
    bb plugin remove "$name" --yes
    have=""
  fi
  if [ -n "$have" ] && [ "$have_ok" = 1 ]; then echo "== $name: already installed from $have"; continue; fi
  if [ "${have_ok:-0}" = move ]; then echo "== $name: moving from $have (settings kept)"; else echo "== $name: installing"; fi
  bb plugin install "path:$REPO" --plugin "$name" --yes
done
bb plugin list | grep -A1 -E "^($(names "$@" | paste -sd'|' -))@"
