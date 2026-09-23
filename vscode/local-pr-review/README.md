# Local Review

A VS Code extension for reviewing your own changes locally, as inline comment
threads on a diff, before they become a pull request. It is the editor half of
the local review kit in this repository: the Claude Code skills under
`claude/skills` post their findings into it as threads, you triage them here,
and `/apply-review` applies the ones you accepted.

This is a fork of [Local PR Review](https://github.com/Gururagavendra/vscode-local-pr-reviewer)
by Gururagavendra (MIT), extended by [@nchamo](https://github.com/nchamo) and
now maintained here. The original license is retained in `LICENSE`.

## What it does

- **Two review modes.** *Uncommitted* shows the working tree against HEAD,
  grouped into staged, unstaged and untracked. *Whole branch* shows the branch
  against its base, which is the remote's default branch unless the
  `localPrReview.defaultBase` setting or **Set review base** says otherwise.
- **Inline threads** on any line of a diff, through VS Code's native comment
  UI, with reply, edit, delete, resolve, and **Suggest a Change** (a diff block
  that `/apply-review` applies verbatim).
- **Triage of threads you did not write.** Threads posted by the review skills
  (`team`, `codex`, `learnings`) or imported from a GitHub PR land in a
  *Needs your OK* group. Each offers **Queue for apply**, **Ignore**, and
  **Skip always**, and a **Triage** command walks the queue one thread at a
  time. Your own threads need no triage.
- **Comments navigator** grouping threads by state (mine, needs OK, queued,
  applied, resolved, muted) with resolve, reply, and mute actions from the tree.
- **Reviewed tracking** per file and per hunk (`ctrl+shift+r`), keyed on file
  content so a checkbox clears when the file changes.
- **Identity.** Threads are yours when their first comment is by your OS user
  or your GitHub login, so notes you left on a PR are not queued for your own OK.
- **Anchors.** Each thread keeps the code it was written against, so it stays
  attached through line drift and shows when it has gone stale.
- **Copilot tool.** `#localReviewComments` in Copilot chat reads the threads.

## Storage

Everything lives under `.vscode/local-reviews/` in the repository, which the
kit's global git ignore keeps out of commits:

- `registry.json` lists the review sessions and which one is active.
- `<source>_<target>/comments.json` holds that session's threads. Each thread
  has a file path, a line range, a state, an optional `disposition`
  (`accepted` or `dismissed`) and `applied` flag from triage, and its comments,
  each with an author and a `channel` (`local`, or `github` when imported).

The scripts in `claude/scripts` read and write the same files, which is how
the skills and the editor stay in sync. Run **Local Review: Refresh** after a
script has posted.

## Changes from the original

- Replaced the branch-selector webview with the two review modes above and
  automatic base detection.
- Added triage: dispositions, the applied flag, the Needs-your-OK queue, the
  Triage picker, mute, and the canned triage comments the scripts recognize.
- Added GitHub import support: threads carry their PR comment ids, reviewer
  avatars, original timestamps, and the `channel` marker.
- Added identity handling for your own comments imported from a PR.
- Added anchors and stale detection, plus per-hunk reviewed tracking.
- Added the comments navigator groups and their inline actions.
- Removed the marketplace packaging; this fork is built and installed from
  source by `install.sh` at the repository root.

## Building

```sh
npm ci --ignore-scripts
npm run package        # compiles and writes ../local-pr-review.vsix
```

`install.sh` at the repository root does both and installs the result, using
`code` when it is on PATH or the VS Code server on a Remote-SSH host otherwise.
Reload Window in VS Code afterwards.
