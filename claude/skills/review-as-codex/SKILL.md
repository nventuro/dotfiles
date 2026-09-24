---
name: review-as-codex
description: Ask Codex to independently review current changes using the local checkout, with Claude preparing scope, base branch, and context.
argument-hint: "[PR-number | branch-name | uncommitted]"
---

# Review As Codex

Prepare a grounded review request for Codex. Claude gathers scope and context;
Codex reviews the real local checkout. Do not treat Claude's summary as
authoritative, and do not ask Codex to confirm Claude's conclusions.

## Workflow

### 1. Determine scope

If an argument is passed:

- `uncommitted`: review staged, unstaged, and untracked local changes.
- PR number: review that PR.
- Branch name: review that branch against its base.

Otherwise detect scopes in parallel:

```bash
[ -z "$(git status --porcelain)" ]                 # exit 1 = uncommitted changes exist
git log @{u}..HEAD --oneline 2>/dev/null           # non-empty = unpushed commits
gh pr view --json number,title,url --jq '"\(.number) \(.title)"'  # ok = current branch has PR
```

If multiple scopes have content, ask the user which one Codex should review.
If exactly one has content, use it and announce the selected scope.

### 2. Determine base branch

Never assume `main` or `master`.

If a PR exists, the PR base is authoritative:

```bash
gh pr view --json baseRefName -q '.baseRefName'
```

Otherwise use the remote's default branch:

```bash
git symbolic-ref -q --short refs/remotes/origin/HEAD | sed 's|^origin/||' \
  || gh repo view --json defaultBranchRef -q .defaultBranchRef.name
```

If the branch was cut from something else (a stacked branch, a release line),
ask the user which base to use.

### 3. Gather context

Collect concise context for Codex:

- the goal of the change or the issue it solves
- tests, builds, or CI already run and their results (with CI failure URLs or
  log excerpts, if relevant)
- **assumptions and decisions**, only when this session wrote or changed the
  code under review: the things taken for granted without checking, and the
  design choices made. Write each as a concrete, checkable claim about the
  code ("`parse` is only ever called with trimmed input", "kept the cache
  write synchronous so readers never see a stale entry"). If this session did
  not write the code (a fresh session, someone else's PR), leave this out
  rather than guess.

Do not add your own opinions of what looks risky, and do not list the changed
files: Codex enumerates the changes itself, and its value is an independent
read. Do not paste the full diff unless the user is asking to review an
external PR that Codex cannot inspect locally.

Useful commands:

```bash
git branch --show-current
git status --short
git diff --name-only <base>...HEAD
git diff --name-only
git diff --cached --name-only
git ls-files --others --exclude-standard
```

For PR scope:

```bash
gh pr view <number> --json number,title,url,baseRefName,headRefName,state
gh pr diff <number> --name-only
```

### 4. Hand off to Codex

Resolve the repository root dynamically and run Codex from that directory:

```bash
repo_root=$(git rev-parse --show-toplevel)
```

If a Codex CLI is available and the user wants Claude to invoke it, run
`codex review` from `$repo_root` with the prompt as the positional argument.
Otherwise print the prompt for the user to paste into Codex.

One constraint (codex-cli 0.142+): **the scope flags (`--uncommitted`,
`--base`) cannot be combined with a custom prompt** — `codex review
--uncommitted <prompt>` (and the stdin `-` form) both fail with `the argument
'--uncommitted' cannot be used with '[PROMPT]'`. So when passing Claude's
context prompt, pass ONLY the prompt and encode the scope inside it (tell Codex
which changes to review and how to enumerate them, e.g. `git status
--porcelain` + `git diff HEAD` for uncommitted work). Use the bare flag forms
only when sending no prompt.

```bash
codex review "$PROMPT"
```

If Codex answers that it could not inspect the local checkout because of a
sandbox setup error, rerun with the sandbox disabled — acceptable for a
read-only review of a trusted local repo:

```bash
codex review -c 'sandbox_mode="danger-full-access"' "$PROMPT"
```

Build `$PROMPT` from the template below, with `<repo_root>` set to `$repo_root`.
The first paragraph states the scope:
use the uncommitted form shown, or for branch/PR scope "Review the changes on
this branch against `<base>` in the repository at <repo_root>; enumerate them
there with `git diff <base>...HEAD`."
Omit the Goal or Already-run line when there is nothing concrete for it, and
omit the whole assumptions section when step 3 left it out.

```text
Review the current UNCOMMITTED changes in the repository at <repo_root>
(staged, unstaged and untracked); enumerate them there with
`git status --porcelain` and `git diff HEAD`.

Goal of the change: ...
Already run: ...

Assumptions and decisions made while writing this change. None of them has
been verified. Treat each as suspect: check it against the code and its
callers, and report it as a finding if it is wrong. Report a decision only if
it causes a bug or clearly worse behavior, not because you would have chosen
differently. These are a starting point, not the scope: review the whole change.
- ...

Report only problems worth fixing before this merges: bugs, unhandled edge
cases, security issues, broken error handling, missing tests for new
behavior, and names that mislead or could be clearer. Skip formatting and
other style. Leave out anything you are unsure of; an empty result is fine.
Do not modify files.

Output only a fenced ```json array. Each finding:
{ "file": <repo-relative path>,
  "line": <first line, numbered in the current file>,
  "end_line": <last line, if more than one>,
  "severity": "high" | "medium" | "low",
  "body": <one sentence>,
  "suggestion": { "before": <exact current lines, unique in the file>,
                  "after": <replacement lines> } | null }
```

If the review target is an external PR or branch that is not checked out
locally, include exact checkout/fetch instructions or the PR diff location in
the prompt.

### 5. Integrate Codex results

After Codex replies, check for an active **Local PR Review**:
```bash
python3 ~/.claude/scripts/local-review-post.py status
```

**If `active: true` → post Codex's findings as inline threads** (don't just print them):
- Parse the ```json array Codex returned. For each, build
  `{ "file", "line", "endLine": <end_line, or line when absent>, "author": "codex", "body" }`.
  `body` = `"[<severity>] (codex)\n\n<body>"`,
  plus — when the finding has a `suggestion` `{before, after}` — a verbatim-applicable block
  (`/apply-review` applies it as-is):
  ````
  💡 **Suggestion:**

  ```diff
  - <before>
  + <after>
  ```
  ````
- Discard a finding only if it is clearly invalid after checking the file.
- Post: `printf '%s' "$FINDINGS_JSON" | python3 ~/.claude/scripts/local-review-post.py post`
- Tell the user: "Posted N Codex findings to Local PR Review — run **Local PR Review:
  Refresh**, review/edit/resolve, then `/apply-review`."

**Else** (no active review): present Codex findings without rewriting their substance,
discard only what's clearly invalid, and ask whether to apply fixes. Claude implements
any that are accepted; Codex only reviews.

Do not post to GitHub unless the user explicitly asks.
