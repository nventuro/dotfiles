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
| `vscode/local-pr-review/` | VS Code extensions | The Local Review extension, built from source |

## Local review kit

A review loop that runs before a PR exists. Claude Code and Codex review your
diff, their findings appear as inline comment threads in VS Code through the
Local Review extension, you triage them there, and `/apply-review` applies what
you accepted. The two sides share one JSON file per review under the repo's
`.vscode/local-reviews/`.

Skills: `/local-review` runs every pass and posts the threads. `/review-as-team`
checks the diff against your reviewers' learned patterns, `/review-as-codex`
gets an independent Codex review. `/apply-review` applies queued threads and
answers your replies. `/load-pr-comments` pulls a real PR's review threads in.
`/learn` records one of your own rules; `/learn-from-prs` learns your
reviewers' patterns from merged PRs.

The kit keeps its personal state outside this repo, in `~/.claude/local-review/`:
`config.json` (your GitHub login, teammates, and the repos to learn from) plus
the learnings files the reviews read. `install.sh` creates the directory and an
empty `config.json` to fill in.

The extension is a fork; see `vscode/local-pr-review/README.md`. Building it
needs `npm`, and installing it uses `code` when on PATH, else the VS Code
server of a Remote-SSH host. Reload Window in VS Code after `install.sh`.
