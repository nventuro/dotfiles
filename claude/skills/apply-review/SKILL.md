---
name: apply-review
description: Read the review comments left in VS Code's "Local PR Review" extension (.vscode/local-reviews/) and apply the ones you agree with as code changes (pushing back in-thread on the ones you don't). Selection + the comments-file writes are done by helper scripts so it stays fast, then it distills the generalizable ones into your coding-preferences learnings as a final step. Use when the user says "/apply-review" or asks to apply their review comments after commenting on a diff in VS Code.
argument-hint: "[thread-id] (default: your unresolved comments + accepted ones)"
allowed-tools: [Bash, Read, Edit, Write]
---

# Apply Review Comments

Apply the review comments the user left on a diff in VS Code using the **Local PR
Review** extension (`nventuro.local-pr-review`). Comments are stored as JSON
under `.vscode/local-reviews/`; read the active review's threads and act on each
one: where you **agree**, make the change and mark the thread resolved; where you
**disagree** (or can't tell what's meant), don't touch the code — reply in the
thread with your reasoning or question and leave it unresolved for the user.

This runs without prompting you for approval: it decides per thread and writes its
replies into the review file. Two helper scripts keep it fast — `list-actionable`
picks the threads to act on, and `apply-results` makes all the comments-file changes
in one write — so the only per-thread work is the judgment + the code edit.
As a final step (after the report) it distills the generalizable comments into your
preferences file — automatically, nothing to run yourself. You review the outcome
afterward in VS Code (**Local PR Review: Refresh**).

## Storage layout

At the repo root, `.vscode/local-reviews/`:
- `registry.json` — `{ version, reviews: [...], activeReviewId }`. Each review:
  `{ id, sourceBranch, targetBranch, sourceCommit, targetCommit, createdAt }`.
- `<sourceBranch>_<targetBranch>/comments.json` (slashes in branch names → `-`) —
  the threads: `{ version, sourceBranch, targetBranch, sourceCommit, targetCommit, threads: [...] }`.

Each **thread**:

| field | meaning |
|---|---|
| `id` | thread id — match on this to mark resolved or target a single one |
| `filePath` | path relative to the repo root |
| `startLine` / `endLine` | the commented line range |
| `state` | `unresolved` or `resolved` — skip resolved |
| `disposition` | only on threads you didn't author (`team`/`codex`/`learnings`/a GitHub login): `accepted` = you clicked **"Queue for apply"** in VS Code (also posts a "✅ Queue for apply" `local` comment). Absent = not triaged → skip |
| `comments` | array of `{ id, body, author, timestamp, channel }`; `comments[0].body` is the review note, later entries are replies |
| `channel` (per comment) | `github` = imported from the PR conversation — **never author here** (it'd imply speaking on the PR); `local` = private to you + Claude, never synced. Your replies are **always** `channel: "local"`. Absent = treat as `local`. |

## Steps

0. **Sync the PR first (auto-load), if there is one.** If the current branch has
   an open GitHub PR, pull its review comments into the active review before
   applying, so you act on the latest. This is the same idempotent sync
   `/load-pr-comments` does; skip it silently if there's no PR. From the repo root:

   ```bash
   python3 ~/.claude/scripts/local-review-post.py ensure-review >/dev/null
   PR=$(gh pr view --json number -q .number 2>/dev/null)
   if [ -n "$PR" ]; then
     gh api "repos/{owner}/{repo}/pulls/$PR/comments" --paginate --jq '.[]' | jq -s . > /tmp/pr-comments.json
     python3 ~/.claude/scripts/github-pr-to-findings.py /tmp/pr-comments.json | python3 ~/.claude/scripts/local-review-post.py post
   fi
   ```

1. **Get the actionable threads — one call does the selection.** From the repo root:

   ```bash
   python3 ~/.claude/scripts/local-review-post.py list-actionable
   ```

   It returns `{ active, comments_file, threads: [...] }` — the threads you should
   act on, **already selected** (don't re-derive the filter or re-scan the file) and
   sorted by `filePath` then `startLine`. Each thread:
   `{ id, filePath, startLine, endLine, reason, isMine, isGithub, applied,
   disposition, note, replies[], anchor }`. Two reasons:
   - **`reason: "apply"`** — make the change the `note` asks for. You either authored
     it, or it's a not-yours thread you **queued** ("Queue for apply"). A queued
     thread may carry extra `local` `replies` beyond the canned note (e.g. "apply,
     but camelCase") — treat those as part of the directive.
   - **`reason: "reply"`** — a fresh, unanswered `local` note from the user on a
     thread that's otherwise done (`applied`) or never queued. **Answer it** (step 3);
     change code **only if the note explicitly asks**. This is the "a new reply
     re-opens a thread" case — including a GitHub thread you'd otherwise skip (the
     user asking you something privately, never touching the PR).

   If `active` is false or `threads` is empty, tell the user there's nothing to apply
   (did they add comments and save in VS Code?) and stop. The script already skips
   resolved threads, un-queued not-yours proposals, and applied threads with no new
   reply — trust it; don't second-guess by re-reading the whole comments file.
   - If a **`thread-id`** argument was given, act on just that thread: read it from
     `comments_file` directly (it may be resolved/applied — the user is forcing it).

2. **Decide and act — grouped by file.** The threads come sorted by file, so handle
   all of one file's threads in a batch: read `<repo-root>/<filePath>` **once**, then
   make all its edits. The `anchor` field is the exact code each comment was about —
   use it + the `note` to locate the spot (`startLine` may be 0-/1-based and may have
   drifted; don't trust it alone). Per thread:
   - **`reason: "apply"` + agree** → make the change the note asks for (fix, rename,
     doc addition, a question answered in code).
   - **`reason: "reply"`** → answer the user's note; change code **only if it
     explicitly asks**.
   - **disagree / unclear** → don't touch the code; reply with your reasoning, or the
     specific question you need answered.

   Default to implementing. For your own (`isMine`) "apply" threads, reserve pushback
   for genuine disagreement — when you lean agree, just make the change. For
   **not-yours** "apply" threads, you only see them because the user **queued** them,
   so treat that as a directive; push back only if applying would be actually wrong
   (a correctness or security problem), not a mere preference.
   - **Suggested change blocks:** if a `note` contains a `💡 **Suggestion:**` fenced
     ` ```diff ` block (the extension's "Suggest a Change") and you agree, apply it
     **verbatim** — `- ` lines are the exact original, `+ ` lines the exact
     replacement. Do a precise `old_string → new_string` edit; don't paraphrase.

3. **Record every decision in ONE write — don't hand-edit the comments file.** Build
   a JSON array of results and pipe it to `apply-results` (it does all the
   id/timestamp generation and JSON surgery at once):

   ```bash
   echo '<results-json>' | python3 ~/.claude/scripts/local-review-post.py apply-results
   ```

   Each result is `{ "id", "action", "reply"? }`:
   - **applied a not-yours thread** (`isMine:false`) → `{"id","action":"applied",
     "reply":"<one line of what you did>"}`. Sets `applied:true`, leaves it
     **unresolved** (the *user* verifies + resolves), and posts an "Applied ✅ — …"
     note. Also stops a later run from re-applying it.
   - **applied your own thread** (`isMine:true`) → `{"id","action":"resolve"}` (marks
     it resolved).
   - **pushed back / answered / asked** → `{"id","action":"reply","reply":"<short,
     concrete reply>"}`. Appended as a `claude`/`local` comment; thread stays
     unresolved so it surfaces for the user. Use this for every `reason:"reply"`
     thread and every disagree/unclear one.

   `apply-results` always tags replies `author:"claude" channel:"local"` (never
   synced to GitHub, even on a GitHub thread), preserves every other field + thread
   order, never deletes threads, and reports `{resolved, applied, replied, missing}`
   (`missing > 0` means an id didn't match — recheck it).

4. **Report** briefly: applied as `filePath:startLine — <one line>`, pushed-back as
   `filePath:startLine — pushback: <one line>`, and any you asked about.

5. **Then learn — distill your applied comments into preferences (do this LAST,
   after the report).** For the threads you **applied** that **you authored**
   (`isMine:true`, agreed) — you already have their notes from step 1 — fold the
   *generalizable* ones into `~/.claude/local-review/my-learnings.md` (a
   SessionStart hook injects its headlines into coding sessions). Running it after
   the report keeps the apply *result* fast — the user sees it first. **Don't make
   the user run anything; just do it.**
   - Keep only what predicts *future* feedback: a naming rule, a structure/pattern
     preference, a doc or test convention, a "don't do X". **Drop one-offs** (a typo
     fix, a this-specific-value correction, anything that won't recur). **When in
     doubt, drop** — the file predicts future feedback, it is not an archive. Skip threads
     you pushed back on, and **never** distill `team`/`codex`/GitHub comments — the
     file must stay *your* (the user's) standards.
   - Read the file, then per kept preference (mirroring `/learn-from-prs`'s reduce
     rules): reinforces an existing bullet → bump its `(seen Nx)` count (optionally a
     fresh quote); genuinely new recurring → add `- **Rule** (seen 1x) — …` under the
     right `## <theme>`; a notable single instance (soundness/security/novel
     principle) → `(seen 1x, notable)`; noise → drop. **Write directly — don't ask
     for approval.** Keep each bold headline self-contained (it's what the hook
     injects) and the file tight. If nothing this batch is generalizable, write
     nothing and say so.

## Notes

- Run this from the repo checkout, where `.vscode/local-reviews/` lives and where
  the edits land.
- The extension shows comments **inline** via VS Code's native Comments API. The
  user sets the diff (Base vs Compare) in its sidebar; that's their concern, not
  this skill's — just read whatever review is active.
- `.vscode/local-reviews/` is covered by the global git ignore that `install.sh`
  links, so it never gets committed.
