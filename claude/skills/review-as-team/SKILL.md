---
name: review-as-team
description: Review current changes through the lens of teammate review patterns before submitting a PR.
argument-hint: "[PR-number | branch-name]"
---

# Review As Team

Apply learned reviewer patterns to the current branch's changes with one
reviewer agent that carries all patterns. Findings are posted to the Local PR
Review extension when a review is active, otherwise presented interactively in
the terminal.

## Paths

- Learnings: `~/.claude/local-review/team-learnings.md`
- Tracker:   `~/.claude/local-review/team-learnings-tracker.json`
- Diff file: `/tmp/review-diff.txt`

**Do NOT read the learnings file or diff content into main context.**
The reviewer agent reads them itself.

## Workflow

### 1. Freshness

Check the tracker's `last_run` and whether the learnings file exists:

- **Fresh (≤24h)**: proceed silently.
- **Stale (>24h)**: ask with `AskUserQuestion`
  (header="Learnings", multiSelect=false):
  - question: `"Learnings are N hours old. Update before reviewing?"`
  - options:
    - `Update` — run `/learn-from-prs` synchronously, then continue.
    - `Use current` — proceed with the existing file.
- **Missing or empty**: ask with `AskUserQuestion`:
  - question: `"Learnings file is missing. Run /learn-from-prs now?"`
  - options: `Run now` / `Abort`. If Abort, stop the skill.

### 2. Scope + model

If a PR number was passed as argument, scope = that external PR.
Skip scope detection but still ask for the model.

Otherwise detect scopes in parallel:
```bash
[ -z "$(git status --porcelain)" ]                 # exit 1 = uncommitted (includes untracked)
git log @{u}..HEAD --oneline 2>/dev/null           # non-empty = unpushed
gh pr view --json number,title,url --jq '"\(.number) \(.title)"'  # ok = branch PR exists
```

Ask the user via a single `AskUserQuestion` call with up to two questions:

- **Model** (always asked):
  - header="Model", multiSelect=false
  - options (describe both quality and cost in each description):
    - label=`Fable`, description=`Most capable. Best at subtle patterns and nuanced judgment; highest cost and slowest.`
    - label=`Opus`, description=`Top-tier Opus. Strong on subtle patterns. ~5x the token cost of sonnet and notably slower.`
    - label=`Sonnet`, description=`Solid mid tier. Catches most documented patterns. ~5x cheaper and faster than opus.`
    - label=`Default`, description=`Inherit the session's model (no override).`
- **Scope** (only if multiple scopes have content):
  - header="Scope", multiSelect=false
  - options limited to scopes with content: Uncommitted / All unpushed /
    PR #N: <title> / Full branch.

Map the model choice in step 4:
- Fable → `model: "fable"` in the Agent call.
- Opus → `model: "opus"`.
- Sonnet → `model: "sonnet"`.
- Default → omit the `model` field so it inherits the session.

If exactly one scope has content, use it automatically and announce the
selection — only the model question is asked.

### 3. Write diff to `/tmp/review-diff.txt`

"Uncommitted" means unstaged + staged + untracked. Define these helpers once
before running any of the commands below. `show_untracked` surfaces untracked
files as new-file diffs against `/dev/null` (the `|| true` tolerates
`git diff`'s nonzero exit when content differs). `base_branch` is the branch
the work will merge into: the PR's base if the branch has a PR, otherwise the
remote's default branch.

```bash
show_untracked() { git ls-files --others --exclude-standard | while IFS= read -r f; do git diff -U1 --no-index -- /dev/null "$f" || true; done; }
base_branch() {
  gh pr view --json baseRefName -q .baseRefName 2>/dev/null && return
  local h; h=$(git symbolic-ref -q --short refs/remotes/origin/HEAD) && { echo "${h#origin/}"; return; }
  gh repo view --json defaultBranchRef -q .defaultBranchRef.name
}
```

Each tracked-scope command diffs the working tree against a single base
(`HEAD`, or the merge-base with the upstream / base branch) rather than
concatenating separate `git diff` + `git diff --cached` outputs. A single
net diff cancels an add-then-delete regardless of which side of the index
each lands on, so code the session added and later removed never reaches
the reviewer as a phantom `+` finding.

| Scope        | Command |
|--------------|---------|
| Uncommitted  | `{ git diff -U1 HEAD; show_untracked; } > /tmp/review-diff.txt` |
| All unpushed | `{ git diff -U1 --merge-base @{u}; show_untracked; } > /tmp/review-diff.txt` (fall back to `--merge-base "origin/$(base_branch)"` if no upstream) |
| PR / external PR | `gh pr diff <N> > /tmp/review-diff.txt` |
| Full branch  | `BASE=$(git merge-base "origin/$(base_branch)" HEAD); { git diff -U1 $BASE; show_untracked; } > /tmp/review-diff.txt` |

### 4. Run the reviewer agent

Single Agent call, `subagent_type: "general-purpose"`. Pass `model` based on
the step-2 selection (Fable / Opus / Sonnet; Default → omit). Prompt instructs
the agent to:

- Read `/tmp/review-diff.txt` for the diff.
- Read the learnings file at the path above.
- Apply every top-level `## <name>` reviewer section to the diff.
  Skip `## Other Reviewers` and `## Cross-Reviewer Themes`.
- For each issue, tag `flagged_by` with every reviewer whose pattern
  matched (e.g. `["alice", "bob"]`).
- Return a single JSON array, nothing else. Empty array if no findings.
- Do not narrate approvals or comment on what was fine.

**Finding schema**:
```json
{
  "category": "Naming|Security|Clarity|ApiDesign|Architecture|Style|...",
  "file": "path/to/file.ts",
  "line": 42,
  "issue": "short description of the problem",
  "fix": "short description of the change",
  "preview_before": "3-8 lines of context around the issue",
  "preview_after": "the same lines with the fix applied",
  "flagged_by": ["alice", "..."]
}
```

### 5. Merge + sort

- If two findings share `(file, line)` and the issues look equivalent,
  merge them and union their `flagged_by` arrays.
- Sort by priority (Security/Correctness > ApiDesign > Architecture >
  Clarity > Style), then file path, then line number.
- Number sequentially `#1..#N`.

### 6. Present the findings

First check for an active **Local PR Review**:
```bash
python3 ~/.claude/scripts/local-review-post.py status
```

**If `active: true` → Local PR Review mode.** Post the findings as inline threads
instead of asking in the terminal, then stop:
- Build a JSON array; each item `{ "file": <path>, "line": <n>, "author": "team",
  "body": <markdown> }`.
- `body` starts `"[<category>] (team, flagged by <names>) <issue>"`. For a concrete
  fix, append a suggestion block (the extension's format; `/apply-review` applies it
  verbatim) built from the finding's `preview_before`/`preview_after`:
  ````
  💡 **Suggestion:**

  ```diff
  - <preview_before — the exact current lines>
  + <preview_after — the lines with the fix>
  ```
  ````
  Omit the block for a question/note finding. Keep `preview_before` byte-exact so the
  verbatim edit matches.
- Post: `printf '%s' "$FINDINGS_JSON" | python3 ~/.claude/scripts/local-review-post.py post`
- Tell the user: "Posted N findings to Local PR Review — run **Local PR Review:
  Refresh**, review/edit/resolve, then `/apply-review`." **Then stop** — do not run
  the terminal flow (steps 7–8) or any `AskUserQuestion`.

**Else → terminal mode** (steps 6–8 below).

Print:
```
## Review: N recommendations across M files
```

Build one `AskUserQuestion` per finding:
- `header`: `"#X [Category]"` (truncate category to 12 chars).
- `question`: `"<issue> (<file>:<line>, flagged by <names>)"`.
- `preview`: a code fence showing `preview_before` with line numbers
  and a short annotation, followed by `**Fix:** ...` and a fence with
  `preview_after`.
- `multiSelect`: false.
- options: `Apply` (apply the suggested fix) / `Skip` (leave as-is).

Batch up to 4 per `AskUserQuestion` call. Wait for each batch before
showing the next. Record each choice. "Other" responses carry custom
user instructions for that finding.

### 7. Apply

- Plan mode: present a plan summarizing the selected changes.
- Otherwise: apply each "Apply" via Edit/Write. After each, print
  `Applied [X/N]: <short>`. Apply "Other" per the user's instructions.

### 8. Summary

```
Review complete. Applied X/N recommendations, skipped Y.
```

## Guidelines

- Priority order: Security/Correctness > ApiDesign > Architecture > Clarity > Style.
- Only flag patterns documented in the learnings file. Don't invent concerns.
- Do NOT post to GitHub.
