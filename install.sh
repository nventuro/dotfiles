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
link "$repo/claude/skills" "$HOME/.claude/skills"
link "$repo/claude/scripts" "$HOME/.claude/scripts"
link "$repo/claude/agents" "$HOME/.claude/agents"

# Global git ignore, for per-machine files that tools leave inside every repo
# (the Local Review extension's .vscode/local-reviews/). Git reads it from
# ~/.config/git/ignore when core.excludesFile is unset; a core.excludesFile that
# points elsewhere is deliberate, so that file is left alone and the entries
# have to be added there by hand.
excludes="$(git config --global --get core.excludesFile || true)"
default_excludes="${XDG_CONFIG_HOME:-$HOME/.config}/git/ignore"
if [ -z "$excludes" ] || [ "${excludes/#\~/$HOME}" = "$default_excludes" ]; then
  link "$repo/git/ignore" "$default_excludes"
else
  echo "core.excludesFile points at $excludes; add the lines from git/ignore to it yourself"
fi

# Store for the local-review skills: personal config plus the learnings the
# reviews read. Kept out of the repo: it holds your team roster and fills with
# quoted review comments, some from private repositories.
store="$HOME/.claude/local-review"
mkdir -p "$store"
touch "$store/my-learnings.md"
if [ ! -e "$store/config.json" ]; then
  cat > "$store/config.json" <<'EOF'
{
  "login": "",
  "teammates": [],
  "repos": []
}
EOF
  echo "wrote $store/config.json: fill in login, teammates and repos"
fi

# Local Review VS Code extension: built from source (the vsix is not tracked),
# then installed into whichever VS Code runs extensions on this machine: via
# `code` when it is on PATH (a local VS Code, or the CLI inside a VS Code
# terminal), else via a VS Code server that Remote-SSH installed here. Reload
# Window in VS Code afterwards.
ext="$repo/vscode/local-pr-review"
vsix="$repo/vscode/local-pr-review.vsix"
if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found; skipping the Local Review extension build"
else
  # Lifecycle scripts are not needed by this dependency set; skipping them keeps
  # the install from running arbitrary package code.
  (cd "$ext" && npm ci --ignore-scripts --no-audit --no-fund && npm run package)
  server="$(ls -dt "$HOME"/.vscode-server/cli/servers/Stable-*/server 2>/dev/null | head -1 || true)"
  if command -v code >/dev/null 2>&1; then
    cli=(code)
  elif [ -n "$server" ]; then
    cli=("$server/bin/code-server")
  else
    cli=()
    echo "no VS Code found on PATH; install $vsix via Extensions > ... > Install from VSIX"
  fi
  if [ "${#cli[@]}" -gt 0 ]; then
    # The upstream extension this one forks shares its name under another
    # publisher; an install of it would load alongside this one.
    if "${cli[@]}" --list-extensions 2>/dev/null | grep -qix 'gururagavendra.local-pr-review'; then
      "${cli[@]}" --uninstall-extension Gururagavendra.local-pr-review
    fi
    "${cli[@]}" --install-extension "$vsix"
  fi
fi
