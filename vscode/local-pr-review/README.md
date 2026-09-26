# Local Review

A VS Code extension for reviewing your own changes locally, as inline comment
threads on a diff, before they become a pull request. It is the editor half of
the local review kit in this repository: the Claude Code skills under
`claude/skills` post their findings into it as threads, you decide here what
happens to each one, and `/address-review` carries that out.

This is a fork of [Local PR Review](https://github.com/Gururagavendra/vscode-local-pr-reviewer)
by Gururagavendra (MIT), extended by [@nchamo](https://github.com/nchamo) and
now maintained here. The original license is retained in `LICENSE`.

## What it does

- **Two review modes.** *Uncommitted* shows the working tree against HEAD,
  grouped into staged, unstaged and untracked. *Whole branch* shows the branch
  against its base, which is the remote's default branch unless the
  `localPrReview.defaultBase` setting or **Set review base** says otherwise.
- **Inline threads** on any line of a diff, through VS Code's native comment
  UI, with reply, **Suggest a Change** (a diff block that `/address-review`
  applies verbatim), and edit and delete on your own comments.
- **Stages.** Every thread is in one of four stages:
  - *To do*: your move. New findings land here, and so does every thread
    Claude has handled.
  - *With Claude*: you replied, or chose Apply or Apply & close; the next
    `/address-review` acts on it.
  - *Later*: set aside until the next `/address-review`.
  - *Closed*: finished; nothing more happens with it.

  A thread's header offers the actions that fit its stage: **Apply & close**,
  **Apply**, **Later**, **Discard**, **Undo** and **Reopen**. Hovering a button
  says what it does. Replying, or writing a comment of your own, sends the
  thread to Claude. Only To do threads open in the editor; the rest are
  collapsed to their gutter icon.
- **Comments navigator** grouping threads by stage, each row tagged with why
  it is there (`new`, `Claude replied`, `applied`, …) and offering the same
  actions. **Step through** walks the To do threads one at a time.
- **Reviewed tracking** per file and per hunk (`ctrl+shift+r`), keyed on file
  content so a checkbox clears when the file changes.
- **Identity.** Threads are yours when their first comment is by your OS user.
- **Anchors.** Each thread keeps the code it was written against, so it stays
  attached through line drift and shows when it has gone stale.
- **Copilot tool.** `#localReviewComments` in Copilot chat reads the threads.

## Storage

Everything lives under `.vscode/local-reviews/` in the repository, which the
kit's global git ignore keeps out of commits:

- `registry.json` lists the review sessions and which one is active.
- `<source>_<target>/comments.json` holds that session's threads. Each thread
  has a file path, a line range, a `stage` (`todo`, `claude`, `later` or
  `closed`), on a With Claude thread an optional `request` (`apply` or
  `apply-close`), an `applied` flag saying whether Claude changed code the
  last time it handled the thread, and its comments, each with an author.
- `<source>_<target>/archive/` holds the threads of earlier reviews of that
  session, one file per `/start-review`, kept for reading only.

The scripts in `claude/scripts` read and write the same files, which is how
the skills and the editor stay in sync. Run **Local Review: Refresh** after a
script has posted.

## Changes from the original

- Replaced the branch-selector webview with the two review modes above and
  automatic base detection.
- Added the review stages, their thread actions, and the step-through walk.
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
