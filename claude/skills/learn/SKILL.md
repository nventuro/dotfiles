---
name: learn
description: Record a coding or workflow preference into the learnings store that gets injected into future sessions. Use when the user says "/learn <rule>", "remember this preference", or "from now on do X" about how you work or code.
argument-hint: <the rule to record, or a pointer like "what I just said about naming">
allowed-tools: [Bash, Read, Edit, Write]
---

# Learn

Record a preference the user states explicitly into
`~/.claude/local-review/my-learnings.md`, the store whose bold headlines a
SessionStart hook injects into sessions in the configured repos. This is the
manual entry point; /address-review and /learn-from-prs add to the same file
automatically. All three follow the rules below.

Note: if the request is "whenever EVENT happens, do X automatically", that
needs a hook in settings.json, not a learning — say so and offer to set up the
hook instead.

## Steps

1. Read `~/.claude/local-review/my-learnings.md`.
2. Distill the argument into one rule and record it by the rules below. If the
   argument points at conversation context ("what I just said about naming"),
   distill from that context. If the rules record nothing, say why.

## Rules for my-learnings.md

- Record only what predicts future feedback: a naming rule, a structure or
  pattern preference, a doc or test convention, a "don't do X". Drop one-offs
  (a typo fix, a correction to one specific value, anything specific to the
  current change) and rules your `CLAUDE.md` already states, since it is
  loaded in every session already. When in doubt, drop: the file predicts
  future feedback, it is not an archive.
- What shows a new rule will recur depends on where it comes from: the user
  stating it (/learn), one of the user's own review comments that states a
  general rule rather than fixing one spot (/address-review), or two or more
  of the user's comments in the batch (/learn-from-prs). A single instance
  that matters on its own (soundness, security, a novel design principle) is
  recorded from any source, as `(seen 1x, notable)`.
- Write each as a coding rule ("prefer X", "don't do Y", not "asks for X") in
  the file's format, with a bold headline that stands on its own: the
  headlines are what a SessionStart hook injects into coding sessions.
- If an existing bullet already covers it, bump that bullet's `(seen Nx)`
  count, optionally add a fresh quote, and tighten its wording rather than
  adding a duplicate. Otherwise add a new `(seen 1x)` bullet under the right
  `## theme` header, creating the header only if no existing one fits.
- The hook caps how many rules it injects; don't drop rules to fit.
- Report one line per rule added or bumped, quoting its headline and new
  `(seen Nx)` count, since the file is injected into every session. End the
  report with the warning `python3 ~/.claude/scripts/inject-learnings.py check`
  prints when the file is over the cap, if it prints one.
