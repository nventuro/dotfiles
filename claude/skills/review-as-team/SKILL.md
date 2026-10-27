---
name: review-as-team
description: Review current changes through the lens of teammate review patterns before submitting a PR.
argument-hint: "[PR-number | branch-name] [claude-model] [effort]"
---

# Review As Team

Apply learned reviewer patterns to the current branch's changes with one
reviewer agent that carries all patterns. Findings are posted as threads in the
Local Review extension.

## Paths

- Learnings: `~/.claude/local-review/team-learnings.md`
- Diff file: a fresh file per run, created in step 3

**Do NOT read the learnings file or diff content into main context.**
The reviewer agent reads them itself.

## Workflow

### 1. Learnings file

If the learnings file is missing or empty, ask with `AskUserQuestion`:
- question: `"Learnings file is missing. Run /learn-from-prs now?"`
- options: `Run now` / `Abort`. If Abort, stop the skill.

### 2. Scope + model

If a PR number was passed as argument, scope = that external PR.
Skip scope detection.

Otherwise detect scopes in parallel:
```bash
[ -z "$(git status --porcelain)" ]                 # exit 1 = uncommitted (includes untracked)
git log @{u}..HEAD --oneline 2>/dev/null           # non-empty = unpushed
gh pr view --json number,title,url --jq '"\(.number) \(.title)"'  # ok = branch PR exists
```

If multiple scopes have content, ask which one with `AskUserQuestion`
(header="Scope", multiSelect=false), with options limited to scopes with
content: Uncommitted / All unpushed / PR #N: <title> / Full branch. If exactly
one scope has content, use it automatically and announce the selection.

Model and effort for step 4, without asking the user:

- `<model>` is `fable`, unless the user names a Claude model in the arguments
  (`fable`, `opus`, `sonnet`, `haiku`).
- `<effort>` is `xhigh`, unless the user names an effort level (`low`,
  `medium`, `high`, `xhigh`, `max`).

Make sure a Local Review is active for step 6 to post to, and if this fails,
report its error and stop, so the reviewer agent never runs for findings with
nowhere to go:
```bash
python3 ~/.claude/scripts/local-review-post.py ensure-review
```

### 3. Write the diff

Create a fresh file for this run's diff, so reviews running at the same time in
other worktrees don't overwrite each other's. Use the path it prints, written
out literally, wherever `<diff>` appears below:

```bash
mktemp -t review-diff.XXXXXX
```

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
| Uncommitted  | `{ git diff -U1 HEAD; show_untracked; } > <diff>` |
| All unpushed | `{ git diff -U1 --merge-base @{u}; show_untracked; } > <diff>` (fall back to `--merge-base "origin/$(base_branch)"` if no upstream) |
| PR / external PR | `gh pr diff <N> > <diff>` |
| Full branch  | `BASE=$(git merge-base "origin/$(base_branch)" HEAD); { git diff -U1 $BASE; show_untracked; } > <diff>` |

### 4. Run the reviewer agent

Single Agent call, `subagent_type: "code-reviewer"`, with `model: "<model>"`
and `effort: "<effort>"` from step 2. Its prompt is the template below, with
`<diff>`, `<repo_root>` (`git rev-parse --show-toplevel`) and the output spec
filled in:

```text
Review the diff in <diff> the way the user's teammates would, using the review
patterns in ~/.claude/local-review/team-learnings.md. Read both in full. Each
`## <login>` section holds one reviewer's patterns; apply every section.

The repository is checked out at <repo_root>; paths in the diff are relative
to it. Read the changed files there whenever a pattern depends on the
surrounding code, unless the diff is of a PR that is not checked out here, in
which case work from the diff alone and leave "suggestion" null.

Flag only changed code that matches a documented pattern. Raise nothing the
file does not cover, and leave out matches you are unsure of. An empty result
is fine.

<output spec>
Set "rule" to the bold headline of the pattern matched, and "flagged_by" to
every reviewer whose pattern it matches.
```

**Output spec**, pasted where a template says `<output spec>`. Every review
pass uses it: this one, the learnings pass in `/start-review`, and the general
review prompt in `review-as-codex` that Codex and the claude agent get:

```text
Output only a fenced ```json array. Each finding:
{ "file": <repo-relative path>,
  "line": <first line, numbered in the current file>,
  "end_line": <last line, if more than one>,
  "category": "Security" | "Correctness" | "ApiDesign" | "Architecture"
              | "Clarity" | "Naming" | "Style",
  "rule": <see below>,
  "flagged_by": [<see below>],
  "body": <one or two sentences: what is wrong here and what to change>,
  "suggestion": { "before": <lines copied exactly from the current file, as
                             few as needed, unique in the file>,
                  "after": <replacement lines> } | null }
Use a suggestion only for a concrete code change.
```

### 5. Merge + sort

- If two findings share `(file, line)` and the issues look equivalent,
  merge them and union their `flagged_by` arrays.
- Sort by priority (Security/Correctness > ApiDesign > Architecture >
  Clarity > Naming > Style), then file path, then line number.

### 6. Post the findings

Post the findings as inline threads:
- Build a JSON array; each item `{ "file": <path>, "line": <line>, "endLine":
  <end_line, or line when absent>, "author": "team", "body": <markdown> }`.
- `body` starts `"[<category>] (team, flagged by <names>: <rule>)\n\n<body>"`. When the
  finding has a `suggestion`, append a suggestion block (the extension's format;
  `/address-review` applies it verbatim), with one `- ` line per line of `before` and
  one `+ ` line per line of `after`:
  ````
  💡 **Suggestion:**

  ```diff
  - <before>
  + <after>
  ```
  ````
  Copy `before` unchanged so the verbatim edit matches.
- Post: `printf '%s' "$FINDINGS_JSON" | python3 ~/.claude/scripts/local-review-post.py post`
- Tell the user: "Posted N findings to Local Review — run **Local Review:
  Refresh**, go through To do, then `/address-review`."

## Guidelines

- Priority order: Security/Correctness > ApiDesign > Architecture > Clarity > Naming > Style.
- Only flag patterns documented in the learnings file. Don't invent concerns.
- Do NOT post to GitHub.
