---
name: local-review
description: Run the full local review battery over current changes — self-review against your own learnings, teammate-pattern review (review-as-team), and an independent Codex review — posting all findings to the Local PR Review extension for triage with /apply-review. Use when the user says "/local-review" or asks for a full/complete local review before shipping.
argument-hint: "[PR-number | branch-name | uncommitted]"
---

# Local Review

Three independent passes over one scope. All findings are posted as Local PR
Review threads (author names below), triaged in VS Code, applied with
`/apply-review`:

1. **learnings** — the diff checked against your own standing feedback
   (`~/.claude/local-review/my-learnings.md`, the full file — not the
   SessionStart digest).
2. **team** — teammate review patterns (the `review-as-team` skill).
3. **codex** — independent external review (the `review-as-codex` skill).

Do NOT read the learnings files or diff content into main context; the reviewer
agents read them themselves.

## 1. Decide everything once

- Scope: the argument wins; otherwise detect as review-as-team step 2 does
  (uncommitted / all unpushed / PR / full branch).
- Ensure threads have somewhere to land:
  `python3 ~/.claude/scripts/local-review-post.py ensure-review`
- One `AskUserQuestion` combining every question the passes would ask:
  - Scope (only if several scopes have content).
  - Model for the learnings + team reviewer agents (review-as-team's
    Fable/Opus/Sonnet/Default options).
  - Team learnings freshness (only if `team-learnings.md` is >24h old:
    Update via `/learn-from-prs` / Use current).
- Write the diff once, to a fresh file created as in review-as-team step 3, using
  its commands for the chosen scope. That path is `<diff>` below.

The sub-skills invoked below must not re-ask any of these or rewrite the diff —
enter them at the step noted.

## 2. Codex first, in background

Invoke `review-as-codex` with the chosen scope now — it is the slowest pass.
Follow it through context gathering and prompt building (skip its scope
detection), then launch the `codex review` command with `run_in_background` so
step 3 proceeds while Codex works.

## 3. Learnings + team passes in parallel

Send both in a single message:

**Learnings agent** — one Agent call (`general-purpose`, step-1 model). Its prompt
is this template, with `<diff>`, `<repo_root>` (`git rev-parse --show-toplevel`)
and review-as-team's step-4 output spec filled in:

```text
Review the diff in <diff> against the user's own coding rules in
~/.claude/local-review/my-learnings.md. Read both in full.

The repository is checked out at <repo_root>; paths in the diff are relative
to it. Read the changed files there whenever a rule depends on the
surrounding code, unless the diff is of a PR that is not checked out here, in
which case work from the diff alone and leave "suggestion" null.

Flag only changed code that breaks a rule written in that file. Raise nothing
the file does not cover, and leave out matches you are unsure of. An empty
result is fine.

<output spec>
Set "rule" to the bold headline of the rule broken, and "flagged_by" to
["learnings"].
```

**Team pass** — invoke `review-as-team` entering at its step 4 (reviewer agent,
step-1 model, the same `<diff>`), and collect its findings instead of letting it
post.

## 4. Merge and post

Merge both result sets per review-as-team step 5 (same file/line + equivalent
issue → one finding, union `flagged_by`), then post them per its step-6 Local PR
Review mode. Author is `learnings` when only the learnings pass flagged it, with a
body starting `"[<category>] (learnings: <rule>) <body>"`; `team` otherwise.

## 5. Integrate Codex

When the background Codex run finishes, resume review-as-codex step 5 and post
its findings as author `codex`, skipping any finding equivalent to one already
posted in step 4.

## 6. Summary

Report per-pass finding counts and remind: run **Local PR Review: Refresh**,
triage, then `/apply-review`. A pass returning zero findings is a fine outcome —
report it, don't force findings.

## Guidelines

- Never post to GitHub.
- Priority order when sorting merged findings: Security/Correctness > ApiDesign
  > Architecture > Clarity > Style.
