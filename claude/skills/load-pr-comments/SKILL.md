---
name: load-pr-comments
description: Load a GitHub PR's inline review comments into the Local Review VS Code extension as triageable threads (each tagged with the reviewer's GitHub name + avatar), then reply on each thread with Claude's short recommendation (agree/disagree/alternative, judged against the code on the branch) so you can triage with "Queue for apply" and apply with /apply-review. Creates a whole-branch review automatically if none is open. Use when the user says "/load-pr-comments" or wants to pull PR feedback into the local reviewer.
argument-hint: [pr-number-or-url] (default: current branch's PR)
allowed-tools: [Bash, Read]
---

# Load PR Comments

Pull a GitHub PR's **inline review comments** into the **Local Review** VS Code
extension (`nventuro.local-pr-review`) as inline comment threads — one per
review thread, each tagged with the reviewer's GitHub name and avatar. After
loading, add a short recommendation reply on each thread (step 4) so the user
triages with your take already in the thread. You then
triage them in VS Code: click **"Queue for apply"** on a thread to queue it, and run
**/apply-review**, which applies only the accepted ones (your own comments still
apply by default; everything not yours needs accepting). This is **one-way** — it
never writes anything back to the GitHub PR.

If no review is open in the panel, it first creates a "whole branch" review for
the current branch (the extension adopts it on refresh), so the comments always
land in the plugin — never the terminal.

## Steps

This skill talks to GitHub through `gh api`, so it uses your `gh` login and works
for private repos.

1. **Resolve the repo, PR number, and your login.** Run once and reuse. `$ARG` is
   the PR number or URL passed in, empty for the current branch's PR:

   ```bash
   PR_URL=$(gh pr view ${ARG:+"$ARG"} --json url -q .url 2>/dev/null)
   REPO=$(echo "$PR_URL" | sed -E 's|https://github.com/([^/]+/[^/]+)/pull/.*|\1|')
   PR=${PR_URL##*/}
   ```

   If `$PR_URL` is empty, tell the user "no open PR found for branch
   `$(git branch --show-current)`" and stop.

   Then resolve **your** GitHub login (`$VIEWER`) so the extension files comments
   you wrote on the PR as yours — keeping your own FYI notes for reviewers out of
   the triage "needs your OK" queue. Prefer the authenticated viewer (correct even
   on PRs you didn't author); fall back to the configured login. Never fall back
   to the PR author — that's whoever opened the PR (often NOT you), so on someone
   else's PR it would mark THEIR comments as yours:

   ```bash
   VIEWER=$(gh api user --jq .login 2>/dev/null || true)
   [ -z "$VIEWER" ] && \
     VIEWER=$(python3 -c "import sys; sys.path.insert(0, '$HOME/.claude/scripts'); from local_review_config import load; print(load()['login'])" 2>/dev/null || true)
   ```

   (Even if `$VIEWER` ends up empty, `local-review-post.py` defaults the viewer
   login to the configured one rather than the PR author — belt-and-suspenders.)

2. **Ensure a review exists to load into.** PR comments post into the active
   review; bootstrap a "whole branch" review for the current branch if there
   isn't one (no-op when a review is already active — it loads into that):

   ```bash
   python3 ~/.claude/scripts/local-review-post.py ensure-review
   ```

   This writes the same review record the extension's "Whole branch" toggle would,
   so the panel adopts it (no duplicate review). If it reports `"active": false`
   with an error (not a git repo), tell the user and stop.

3. **Fetch the inline review comments and load them.** Fetch the review comments
   (the ones anchored to a file/line) and pipe them through the transform helper,
   which groups reply chains into one thread, tags each with the reviewer's
   `login` + `avatar_url` (so the extension shows their GitHub picture), and
   rewrites GitHub ```suggestion blocks into the extension's ```diff suggestion
   form (red/green `- old` / `+ new`, applyable by /apply-review):

   ```bash
   gh api "repos/$REPO/pulls/$PR/comments" --paginate --jq '.[]' | jq -s . > /tmp/pr-comments.json

   python3 ~/.claude/scripts/github-pr-to-findings.py /tmp/pr-comments.json \
     | python3 ~/.claude/scripts/local-review-post.py post --viewer-login "$VIEWER"
   ```

   Re-running is **idempotent** — `post` upserts by GitHub comment id at both the
   thread and the comment level: brand-new threads are `posted`, replies added to an
   already-loaded thread are `merged` into it, and comments already present are
   `skipped`. So a re-sync picks up replies you (or reviewers) added on GitHub since
   the last load without duplicating anything. If `post` reports `posted: 0` and
   `merged: 0` with nothing already loaded, tell the user the PR has no inline
   review comments (general/issue comments aren't loaded) and stop.

4. **Add your recommendation to each thread.** Read the `comments_file` from
   `post`'s output. Pick every thread that is `state: "unresolved"` and whose
   **last** comment has `channel: "github"` — i.e. the newest reviewer message
   you haven't responded to yet. (This rule makes re-runs idempotent: once you
   reply, the last comment is yours; a later re-sync only re-selects threads
   with fresh reviewer replies.)

   For each selected thread, read the code it points at **on the current
   branch** (`filePath` + `startLine`–`endLine`; the `anchor` snippet is the
   original hunk) and form a recommendation: 2–4 sentences, leading with a
   bolded verdict:

   - **Agree** — why the comment is right vs the code as it is on the branch.
   - **Disagree** — why the code as-is is preferable to the change asked for.
   - **Alternative** — when a third option beats both, what it is and why.

   Write the replies to a temp file as
   `[{"id": "<threadId>", "action": "reply", "reply": "..."}, ...]` and post
   them in one call (pipe the file — don't heredoc):

   ```bash
   python3 ~/.claude/scripts/local-review-post.py apply-results < /tmp/claude-assessments.json
   ```

   These replies are advisory only: they don't queue or resolve anything, and
   triage still works — "Queue for apply" appends a canned user comment, which is
   what re-opens the thread for /apply-review.

5. **Tell the user it's loaded.** Report posted, merged, and `repaired` (anchors
   refreshed from the diff hunk on already-loaded threads — a re-sync with only
   `repaired > 0` still did useful work, don't call it a no-op), plus how many
   threads got a recommendation reply in step 4, then: "Refresh the **Local
   Review** panel, click **Queue for apply** on the comments you want me to
   apply, **Resolve** the ones you've handled, then run **/apply-review**." Don't
   apply anything yourself — the user triages first.

## Important

- **Nothing goes back to GitHub.** Comments, replies and resolution all flow one
  way (GitHub → local). Resolving a thread in the panel resolves it locally only;
  a thread resolved on GitHub stays open here until you resolve it.
- The reviewer's comment text loads **verbatim**, except GitHub ` ```suggestion `
  blocks, which `github-pr-to-findings.py` rewrites into the extension's ` ```diff `
  suggestion form (using the comment's `diff_hunk` for the original line) so they
  render as a red/green diff and `/apply-review` can apply them. A ` ```suggestion `
  with no recoverable `diff_hunk` is left as-is.
- Run this from the repo checkout, where `.vscode/local-reviews/` lives, so the
  threads land in the active review.
