---
name: learn-from-prs
description: Fetch and analyze review comments from merged PRs, learning your teammates' review patterns and your own standards from the reviews you left.
argument-hint: "[since YYYY-MM-DD]"
---

# Learn From PRs

Fetch merged PRs from the team, analyze review comments, and distill them
into two files in `~/.claude/local-review/`, shared across all worktrees:
your teammates' comments into their review patterns in `team-learnings.md`,
and your own comments into your rules in `my-learnings.md`.

## Helper Script

All PR fetching and filtering is done via a single script:
`~/.claude/scripts/learn-from-prs.py`

This script is pre-approved in permissions. It handles:
- Fetching PRs for all authors via `gh pr list`
- Filtering out processed PRs (reads tracker)
- Checking signal counts via `gh pr view`
- Fetching inline review comments via the pulls-comments API

## Workflow (map-reduce)

Cost discipline: the **map** stage runs on Haiku for cheap noise-filtering
and classification; the **reduce** stage (synthesis, dedup, naming) runs
on the smarter main thread. Don't invert this.

1. **Fetch and filter** unprocessed high-signal PRs:
   ```bash
   python3 ~/.claude/scripts/learn-from-prs.py fetch 2>&1
   ```
   Outputs a JSON array of every unprocessed high-signal PR,
   `{key, repo, number, signal, title, author}`, to stdout, where `key` is
   `"<owner>/<repo>#<number>"`. The search covers the last 180 days by
   default; pass `--since YYYY-MM-DD` (the skill argument, if provided) to
   widen it. Scoring costs about three `gh` calls per PR, so a first run over
   a wide window takes a long time: run it in the background.
   **Always capture stderr.** If the output contains `gh error` or auth
   failure messages, report the error to the user and stop — do not
   treat an auth failure as "no PRs found."

2. **Fetch review data** for all of them in one call, into a fresh
   scratchpad directory:
   ```bash
   python3 ~/.claude/scripts/learn-from-prs.py fetch-comments --out-dir DIR KEY1 KEY2 ...
   ```
   Pass the `key` field from step 1 verbatim (e.g. `owner/repo#585`) — a
   bare number is read as a PR in the first configured repo. The script
   keeps only comments by you and your teammates, never the PR author's own
   except your replies to others on your PRs (each carrying the comment it
   answers as `in_reply_to`), trims each inline comment's diff context,
   and writes `DIR/comments-batchN.json` files sized for one map agent each;
   it prints `[{path, prs, comments}]`. It costs two `gh` calls per PR, so
   run it in the background for large sets.

3. **MAP** — spawn `analyze-pr-reviews` agents (Haiku, in parallel):
   - One agent per batch file from step 2.
   - Pass it the path to its batch file and the reviewer list: your login
     plus your teammates' (see the Roster section below).
   - Have it write its output to `DIR/map-outN.md` and reply with only the
     bullet count, so the map results survive a crash in the reduce step.
   - The agent only filters noise + classifies + extracts quotes. It
     does NOT name patterns or compare against existing learnings.
   - Output is a tight per-reviewer comment list with categories +
     quotes + PR refs.

4. **REDUCE** — main thread (this conversation, on the session's model)
   synthesizes:
   - Read all map outputs, the current `team-learnings.md`, and the current
     `my-learnings.md`.
   - Route each reviewer's bullets: your teammates' to their section in
     `team-learnings.md`, yours to `my-learnings.md`. Write your own as coding
     rules in that file's format, since they are injected into coding
     sessions: "prefer X", "don't do Y", not "asks for X". Skip
     a rule your `CLAUDE.md` already states: it is loaded in every session already.
   - For each reviewer, group their classified comments by
     theme and decide whether each comment:
     (a) reinforces an existing pattern → bump count, optionally add
         a fresh quote;
     (b) is a new recurring pattern (≥2 instances across the batch) →
         add a new bullet;
     (c) is a notable single instance (security/soundness/novel
         design principle) → add as `(seen 1x, notable)`;
     (d) is noise that doesn't predict future feedback → drop. When in
         doubt between (b)/(c) and (d), drop — the file predicts future
         feedback, it is not an archive.
   - Edit both files directly.
   - Keep file under ~300 lines. When merging, prefer abstracting two
     near-duplicate bullets into one tighter one over piling on.

5. **Update tracker** (`~/.claude/local-review/team-learnings-tracker.json`):
   - **Only if PRs were actually processed** (i.e. the fetch returned
     results and the reduce step completed). If the fetch returned an
     empty array — whether due to auth failures, network errors, or
     genuinely no new PRs — do NOT update `last_run`.
   - Append the key of every PR from step 1 (`"<owner>/<repo>#<number>"`)
     to `processed`, including those with no roster comments.
   - Set `last_run` to current ISO timestamp.

6. **Consolidate your own learnings** (piggybacking on this skill's
   freshness cadence — no separate trigger needed): read
   `~/.claude/local-review/my-learnings.md` and re-reduce it in place with
   the same judgment as step 4:
   - Merge near-duplicate bullets into one sharper rule; sum their
     `(seen Nx)` counts.
   - Drop bullets that your `CLAUDE.md` already states.
   - Keep the total bullet count at or under 30. The SessionStart
     injector caps at 30 headlines, so the 30 most predictive rules
     must be the ones that exist; when over, drop the weakest
     `(seen 1x)` non-notable bullets first.
   - When in doubt about a bullet's future value, drop it.
   If nothing needs consolidating, skip silently. Do not touch the
   file's header/format section, only the rule bullets.

7. **Report** summary: PRs fetched, filtered, processed, team patterns
   reinforced/added, and whether your own learnings needed consolidation.
   Then one line per rule added to or bumped in `my-learnings.md`, quoting its
   headline and new `(seen Nx)` count, since that file is injected into every
   session.

## Roster

The roster is the **single source of truth** in
`~/.claude/local-review/config.json`: `login` is you, `teammates` are the people
who review your PRs. The fetch script reads it. Read that file to get the
handles to pass to the analyze-pr-reviews agents.

**Only learn from these people.** When the analyze-pr-reviews agent processes
review data, it MUST ignore comments from anyone not on the roster. The goal
is to predict feedback from your actual reviewers and to capture your own
standards, not to catalog opinions from unrelated contributors. Sections in
`team-learnings.md` are only ever created for teammates, never for you or
anyone off the roster.

If the team composition changes, edit `config.json` — nowhere else.

## Important

- Use the helper script for all fetching (pre-approved, no permission prompts)
- Repos come from `repos` in `config.json`. PRs are addressed as
  `<repo>#<number>` because numbers collide across repos.
- The script sizes batches to fit a map agent's context; don't regroup them
- If no new PRs to process, report that and exit early
- Never post comments on GitHub from this skill — it only reads and distills.
- **Filter to the roster** — when spawning analyze-pr-reviews agents, pass
  them the reviewer list above and instruct them to drop everyone else's
  comments before classifying.
- **Map runs on Haiku, reduce runs on the main thread**. Do not spawn the
  analyze-pr-reviews agent on a bigger model — its job is mechanical
  classification, not synthesis. The model is pinned in the agent's
  frontmatter; don't override.
