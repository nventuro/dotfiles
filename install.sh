#!/usr/bin/env bash
# Symlinks the tracked config files into place. Safe to re-run: existing
# symlinks are replaced, and any real file in the way is kept as a .bak copy.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

link() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ]; then
    rm "$dst"
  elif [ -e "$dst" ]; then
    mv "$dst" "$dst.bak"
    echo "kept existing $dst as $dst.bak"
  fi
  ln -s "$src" "$dst"
  echo "$dst -> $src"
}

link "$repo/claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
link "$repo/claude/settings.json" "$HOME/.claude/settings.json"
link "$repo/claude/statusline.sh" "$HOME/.claude/statusline.sh"
