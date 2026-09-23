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

- repo path and current branch
- selected scope
- base branch
- user goal or issue being solved
- changed files
- tests, builds, or CI already run and their results
- CI failure URLs or log excerpts, if relevant
- areas Claude suspects are risky

Do not paste the full diff unless the user is asking to review an external PR
that Codex cannot inspect locally. Codex should read the checkout itself.

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

Build `$PROMPT` with the scope stated up front, e.g. for uncommitted scope
start it with: "Review the current UNCOMMITTED local changes in this
repository (staged + unstaged + untracked). Use `git status --porcelain` and
`git diff HEAD` to enumerate them." For branch/PR scope, name the base branch
and instruct `git diff <base>...HEAD` instead.

Otherwise print the prompt for the user to paste into Codex. Never use a
hardcoded checkout path; use `$repo_root` in the prompt.

```text
Please review the current local changes in <repo_root>.

Context from Claude:
- Goal: ...
- Scope: ...
- Base branch: ...
- Current branch: ...
- Relevant files: ...
- Tests/CI: ...
- Suspected risky areas: ...

Use a code-review stance: findings first, ordered by severity, with file/line references.
Verify against the local checkout. Do not rely only on this summary.
Check behavior, missing tests, generated/vendor file hazards, base-branch correctness, and repo conventions.
Do not edit files unless explicitly asked after the review.

After the prose review, also output a fenced ```json block: an array of findings, each
{ "file": <path>, "line": <n>, "severity": <str>, "body": <one-line finding>,
  "suggestion": { "before": <exact current lines>, "after": <fixed lines> } | null }.
Use suggestion only for a concrete code change; before must be byte-exact.
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
- Parse the ```json findings block Codex returned. For each, build
  `{ "file", "line", "author": "codex", "body" }`. `body` = `"[<severity>] (codex) <body>"`,
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
discard only what's clearly invalid, ask whether to apply fixes, and if so clarify whether
Claude or Codex implements them.

Do not post to GitHub unless the user explicitly asks.
