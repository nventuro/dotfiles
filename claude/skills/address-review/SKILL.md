---
name: address-review
description: Act on the review threads the user handed to Claude in VS Code's "Local Review" extension (.vscode/local-reviews/) — make the changes they ask for, answer the user's replies, push back in-thread where a change would be wrong — then close each thread or hand it back to the user, and return threads set aside for Later. Selection + the comments-file writes are done by helper scripts so it stays fast, then it distills the generalizable ones into your coding-preferences learnings as a final step. Use when the user says "/address-review" or asks to act on their review comments.
argument-hint: "[thread-id] (default: every thread With Claude)"
allowed-tools: [Bash, Read, Edit, Write]
---

# Address Review

Act on the review threads the user handed to Claude in VS Code using the **Local
Review** extension (`nventuro.local-pr-review`). Threads are stored as JSON under
`.vscode/local-reviews/`, and each one is in a **stage**:

- **To do** — the user's move. Not touched here.
- **With Claude** — the user replied, wrote a comment of their own, or chose
  **Apply** or **Apply & close**. These are what this skill acts on.
- **Later** — set aside until this skill runs; it returns them to To do.
- **Closed** — finished. Never read.

This runs without prompting you for approval: it decides per thread and writes its
replies into the review file. Two helper scripts keep it fast — `list-actionable`
picks the threads With Claude, and `apply-results` records every outcome in one
write — so the only per-thread work is the judgment + the code edit. As a final step
(after the report) it distills the generalizable comments into your preferences
file — automatically, nothing to run yourself. You review the outcome afterward in
VS Code (**Local Review: Refresh**): every thread handled here either closed or came
back to To do.

## Storage layout

At the repo root, `.vscode/local-reviews/`:
- `registry.json` — `{ version, reviews: [...], activeReviewId }`. Each review:
  `{ id, sourceBranch, targetBranch, sourceCommit, targetCommit, createdAt }`.
- `<sourceBranch>_<targetBranch>/comments.json` (slashes in branch names → `-`) —
  the threads: `{ version, sourceBranch, targetBranch, sourceCommit, targetCommit, threads: [...] }`.

Each **thread**:

| field | meaning |
|---|---|
| `id` | thread id — match on this to record an outcome or target a single one |
| `filePath` | path relative to the repo root |
| `startLine` / `endLine` | the commented line range, 0-based as stored (`list-actionable` reports them 1-based) |
| `stage` | `todo`, `claude`, `later` or `closed` |
| `request` | on a `claude` thread: `apply-close` or `apply` when the user asked for the thread's change to be made; absent when they only replied |
| `applied` | whether Claude changed code the last time it handled the thread |
| `comments` | array of `{ id, body, author, timestamp }`; `comments[0].body` is the review note, later entries are replies |

## Steps

1. **Get the threads With Claude — one call does the selection.** From the repo root:

   ```bash
   python3 ~/.claude/scripts/local-review-post.py list-actionable
   ```

   It returns `{ active, comments_file, threads: [...] }` — every thread With Claude,
   **already selected** (don't re-derive the filter or re-scan the file) and sorted
   by `filePath` then `startLine`. Each thread:
   `{ id, filePath, startLine, endLine, request, isMine, note, replies[], anchor }`.

   If `active` is false, tell the user there's no review and stop. If `threads` is
   empty, still run step 3 with `[]` (that returns Later threads to To do), then
   tell the user nothing was With Claude.
   - If a **`thread-id`** argument was given, act on just that thread: read it from
     `comments_file` directly (it may be in any stage — the user is forcing it).

2. **Decide and act — grouped by file.** The threads come sorted by file, so handle
   all of one file's threads in a batch: read `<repo-root>/<filePath>` **once**, then
   make all its edits. The `anchor` field is the exact code each comment was about —
   use it + the `note` to locate the spot (`startLine` is 1-based but may have
   drifted since the comment was written; don't trust it alone). Per thread:
   - **`request: "apply-close"` or `"apply"`** → make the change the thread asks
     for: the `note`, adjusted by any `replies` from the user (e.g. "apply this, but
     use camelCase"; the latest one wins where they conflict).
   - **no `request`** → do what the user's latest comment asks: the `note` on their
     own thread (`isMine`), otherwise their last reply. That can be answering a
     question, changing code, or revising an approach Claude proposed earlier.
     Change code **only if the comment asks** for it.
   - **the change would be wrong, or you can't tell what's meant** → don't touch the
     code; reply with your reasoning, or the specific question you need answered.

   Default to implementing: the user handed these over. Push back only if the change
   would be actually wrong (a correctness or security problem), not over a
   preference.
   - **Suggested change blocks:** if a comment contains a `💡 **Suggestion:**` fenced
     ` ```diff ` block (the extension's "Suggest a Change") and you agree, apply it
     **verbatim** — `- ` lines are the exact original, `+ ` lines the exact
     replacement. Do a precise `old_string → new_string` edit; don't paraphrase.

3. **Record every outcome in ONE write — don't hand-edit the comments file.** Build
   a JSON array of results and pipe it to `apply-results` (it does all the
   id/timestamp generation and JSON surgery at once). Run it exactly once per
   invocation, even with `[]`: it also returns every Later thread to To do.

   ```bash
   echo '<results-json>' | python3 ~/.claude/scripts/local-review-post.py apply-results
   ```

   Each result is `{ "id", "action", "reply" }`, one per thread from step 1:
   - **changed code** → `{"id","action":"applied","reply":"<one line of what you
     did>"}`. The thread closes if its `request` was `apply-close`; otherwise it
     goes back to To do, tagged `applied`, for the user to check.
   - **no code change** (an answer, pushback or question) → `{"id","action":"reply",
     "reply":"<short, concrete reply>"}`. The thread goes back to To do, tagged
     `Claude replied`.

   `apply-results` authors every reply as `claude`, preserves every other field +
   thread order, never deletes threads, and reports `{closed, returned, from_later,
   missing}` (`missing > 0` means an id didn't match — recheck it).

4. **Report** briefly, grouped: closed after applying, as
   `filePath:startLine — <one line>`; back to the user with a change to check;
   back with an answer; pushed back or asked, as
   `filePath:startLine — pushback: <one line>`; and how many Later threads
   returned to To do.

5. **Then learn — distill your applied comments into preferences (do this LAST,
   after the report).** For the threads you **applied** that **you authored**
   (`isMine:true`, agreed) — you already have their notes from step 1 — fold the
   *generalizable* ones into `~/.claude/local-review/my-learnings.md` (a
   SessionStart hook injects its headlines into coding sessions). Running it after
   the report keeps the result fast — the user sees it first. **Don't make
   the user run anything; just do it.**
   - Keep only what predicts *future* feedback: a naming rule, a structure/pattern
     preference, a doc or test convention, a "don't do X". **Drop one-offs** (a typo
     fix, a this-specific-value correction, anything that won't recur). **When in
     doubt, drop** — the file predicts future feedback, it is not an archive. Skip threads
     you pushed back on, and **never** distill `team`/`claude`/`codex`/`learnings` comments — the
     file must stay *your* (the user's) standards. Also skip a rule your `CLAUDE.md` already states:
     it is loaded in every session already.
   - Read the file, then per kept preference (mirroring `/learn-from-prs`'s reduce
     rules): reinforces an existing bullet → bump its `(seen Nx)` count (optionally a
     fresh quote); genuinely new recurring → add `- **Rule** (seen 1x) — …` under the
     right `## <theme>`; a notable single instance (soundness/security/novel
     principle) → `(seen 1x, notable)`; noise → drop. **Write directly — don't ask
     for approval.** Keep each bold headline self-contained (it's what the hook
     injects) and the file tight. Then finish with one line per rule added or
     bumped, quoting its headline and new `(seen Nx)` count, since the file is
     injected into every session. If nothing this batch is generalizable, write
     nothing and say so.

## Notes

- Run this from the repo checkout, where `.vscode/local-reviews/` lives and where
  the edits land.
- The extension shows comments **inline** via VS Code's native Comments API. The
  user sets the diff (Base vs Compare) in its sidebar; that's their concern, not
  this skill's — just read whatever review is active.
- `.vscode/local-reviews/` is covered by the global git ignore that `install.sh`
  links, so it never gets committed.
