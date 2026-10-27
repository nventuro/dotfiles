---
name: start-review
description: Start a fresh local review of current changes — archive the previous review's threads, then run the full battery (self-review against your own learnings, teammate-pattern review via review-as-team, and independent general reviews by Claude and Codex), posting every finding as a To do thread in the Local Review extension for you to decide on and /address-review to act on. Use when the user says "/start-review" or asks for a full/complete local review before shipping.
argument-hint: "[PR-number | branch-name | uncommitted] [claude-model] [codex-model] [effort]"
---

# Start Review

Starts a fresh review: the previous review's threads are archived, then four
independent passes run over one scope. All findings are posted as To do threads
in the Local Review extension (author names below); the user decides in VS Code
what happens to each, and `/address-review` carries it out:

1. **learnings** — the diff checked against your own standing feedback
   (`~/.claude/local-review/my-learnings.md`, the full file — not the
   SessionStart digest).
2. **team** — teammate review patterns (the `review-as-team` skill).
3. **claude** — a general review by a fresh Claude agent, given the same prompt
   as Codex.
4. **codex** — independent external review (the `review-as-codex` skill).

Do NOT read the learnings files or diff content into main context; the reviewer
agents read them themselves.

## 1. Decide everything once

- Scope: the argument wins; otherwise detect as review-as-team step 2 does
  (uncommitted / all unpushed / PR / full branch).
- Models and effort, never asked: the learnings, team and claude reviewer
  agents use the model and effort review-as-team step 2 resolves from the
  arguments, and Codex the ones review-as-codex step 4 resolves. An effort level
  named in the arguments applies to all four passes.
- Ensure threads have somewhere to land:
  `python3 ~/.claude/scripts/local-review-post.py ensure-review`
- Check what the previous review left unfinished:
  `python3 ~/.claude/scripts/local-review-post.py pending`. Each entry is a thread
  handed to Claude that `/address-review` hasn't handled, or one of the user's
  own comments that isn't closed.
- One `AskUserQuestion` combining every question the passes would ask:
  - Archive anyway (only if `pending` is non-empty): list the pending threads as
    `filePath:line — note`. Archiving keeps them in the archive but out of the
    new review; a "no" stops here, so the user can finish them first with
    `/address-review`.
  - Scope (only if several scopes have content).
- Archive the previous review. This moves every thread to the review's
  `archive/` directory and clears its Reviewed marks:
  `python3 ~/.claude/scripts/local-review-post.py archive`
- Write the diff once, to a fresh file created as in review-as-team step 3, using
  its commands for the chosen scope. That path is `<diff>` below.

The sub-skills invoked below must not re-ask any of these or rewrite the diff —
enter them at the step noted.

## 2. Build the general review prompt

Invoke `review-as-codex` with the chosen scope. Follow it through context
gathering and prompt building (skip its scope detection) to get `$PROMPT`, but
don't run `codex exec` yet: step 3 launches it with the other passes.

## 3. All four passes in parallel

Send all four in a single message:

**Codex** — review-as-codex's `codex exec` command (step-1 Codex model and
effort), with `run_in_background`. Prefix the command with `SECONDS=0; ` and end
it with `; echo "codex took ${SECONDS}s"`, so it reports how long the pass ran
(step 6); if Codex has to be rerun, add the two times.

**Learnings agent** — one Agent call (`code-reviewer`, step-1 model and effort). Its prompt
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
step-1 model and effort, the same `<diff>`), and collect its findings instead of
letting it post.

**Claude agent** — one Agent call (`code-reviewer`, step-1 model and effort) whose prompt
is exactly the `$PROMPT` from step 2, so both general reviewers
get the same scope, context and assumptions to distrust, and return the same
JSON. It starts with none of this session's context, which is what makes it a
second opinion rather than a re-read of Claude's own work.

## 4. Merge and post

Merge the learnings and team results per review-as-team step 5 (same file/line
+ equivalent issue → one finding, union `flagged_by`), then post them per its
step 6. Author is `learnings` when only the learnings pass flagged it, with a
body starting `"[<category>] (learnings: <rule>)\n\n<body>"`;
`team` otherwise. Give each finding `"passes"`: `"learnings"` when its
`flagged_by` includes `learnings`, and `"team"` when it includes anyone else.
Keep the `ids` that `post` prints (each finding's thread, in input order) for
step 5.

Hold the claude and Codex findings until both are in and this step has posted
(step 5 checks them against these threads).

## 5. Merge the general reviews

Once the claude agent and Codex have both finished, take Codex's findings from
review-as-codex step 5 and merge them with the claude agent's. Claude and Codex review
independently, so a finding both raised is the strongest signal of the run:

- A finding both raised (same file, overlapping lines, same issue) becomes one
  thread, authored `claude`, with a body starting
  `"[<category>] (claude, codex agree)\n\n<body>"` (the higher-priority of the
  two categories, per Guidelines), the more concrete of the two suggestions,
  and `"passes": ["claude", "codex"]`.
- Every other finding keeps its own reviewer as author, with a body starting
  `"[<category>] (<reviewer>)\n\n<body>"`.

A finding equivalent to one posted in step 4 is not posted again; instead,
record that its reviewers raised that thread too:
`printf '%s' '[{"id": "<thread id>", "passes": ["claude"]}]' | python3 ~/.claude/scripts/local-review-post.py add-passes`.
Post the rest the way review-as-codex step 5 posts Codex's.

## 6. Summary

Get the per-pass counts with
`python3 ~/.claude/scripts/local-review-post.py stats` and report in this format:

```text
Archived 12 threads → <archive_file>

  pass        found   unique     time
  learnings       9   6 (67%)    1m 52s
  team           11   6 (55%)    3m 05s
  claude          7   5 (71%)    2m 41s
  codex           1   1 (100%)   7m 18s

23 To do threads after dedup
```

- The archive line comes from step 1's `archive` output; leave it out when
  nothing was archived.
- `found` and `unique` are each pass's counts from `stats`, with `unique` also
  as a percentage of `found`. A pass missing from `stats` found nothing: show
  `0` and `—`. The thread total is `stats`' `threads`.
- `time` is how long each pass ran: the `duration_ms` in its agent's completion
  notification (for the team pass, its reviewer agent's), and for Codex the time
  its command printed.
- End the summary with the warning
  `python3 ~/.claude/scripts/inject-learnings.py check` prints when
  `my-learnings.md` is over the cap, if it prints one.

Then remind: run **Local Review: Refresh**, go through To do (**Step through** in
the Comments view), then `/address-review`. A pass returning zero findings is a
fine outcome — report it, don't force findings.

## Guidelines

- Never post to GitHub.
- Priority order when sorting merged findings: Security/Correctness > ApiDesign
  > Architecture > Clarity > Naming > Style.
