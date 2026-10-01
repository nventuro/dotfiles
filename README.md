# dotfiles

Personal config, symlinked into place by `install.sh`. Safe to re-run: existing
symlinks are replaced, and a real file in the way is kept as a `.bak` copy.

```sh
git clone git@github.com:nventuro/dotfiles.git ~/dotfiles
~/dotfiles/install.sh
```

## Layout

| Path | Installed at | What |
|---|---|---|
| `claude/CLAUDE.md` | `~/.claude/CLAUDE.md` | Standing instructions for Claude Code |
| `claude/settings.json` | `~/.claude/settings.json` | Claude Code settings, including the SessionStart hook |
| `claude/statusline.sh` | `~/.claude/statusline.sh` | Status line script |
| `claude/skills/` | `~/.claude/skills/` | Skills, including the local review kit below |
| `claude/scripts/` | `~/.claude/scripts/` | Helper scripts the skills call |
| `claude/agents/` | `~/.claude/agents/` | Subagents the skills spawn |
| `git/ignore` | `~/.config/git/ignore` | Global git ignore |
| `readline/inputrc` | `~/.inputrc` | Readline key bindings |
| `vscode/local-pr-review/` | VS Code extensions | The Local Review extension, built from source |

## Local review kit

A review loop that runs before a PR exists. Claude Code and Codex review your
diff, their findings appear as inline comment threads in VS Code through the
Local Review extension, you decide there what happens to each one, and
`/address-review` carries it out. The two sides share one JSON file per review under the repo's
`.vscode/local-reviews/`.

Skills: `/start-review` archives the previous review's threads, then runs every
pass and posts the new threads: your own rules, your reviewers' learned
patterns (`/review-as-team`), and general reviews by a fresh Claude agent and
by Codex (`/review-as-codex`), both given the same prompt. `/address-review`
acts on the threads you sent to Claude: it applies them and answers your
replies, then hands each one back to you or closes it.
`/learn` records one of your own rules; `/learn-from-prs` learns your
reviewers' patterns, and your own rules from the reviews you left, from merged PRs.

The kit keeps its personal state outside this repo, in `~/.claude/local-review/`:
`config.json` (your GitHub login, teammates, and the repos to learn from) plus
the learnings files the reviews read. `install.sh` creates the directory and an
empty `config.json` to fill in.

The extension is a fork; see `vscode/local-pr-review/README.md`. Building it
needs `npm`, and installing it uses `code` when on PATH, else the VS Code
server of a Remote-SSH host. Reload Window in VS Code after `install.sh`.
