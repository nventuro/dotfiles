---
name: learn
description: Record a coding or workflow preference into the learnings store that gets injected into future sessions. Use when the user says "/learn <rule>", "remember this preference", or "from now on do X" about how you work or code.
argument-hint: <the rule to record, or a pointer like "what I just said about naming">
allowed-tools: [Read, Edit, Write]
---

# Learn

Record a preference the user states explicitly into
`~/.claude/local-review/my-learnings.md`, the store whose bold headlines a
SessionStart hook injects into sessions in the configured repos. This is the
manual entry point; /apply-review distills review comments into the same file
automatically. Use the same file and format for both.

Note: if the request is "whenever EVENT happens, do X automatically", that
needs a hook in settings.json, not a learning — say so and offer to set up the
hook instead.

## Steps

1. Read `~/.claude/local-review/my-learnings.md`.
2. Distill the argument into one self-contained bold headline plus a short
   description, following the file's own format rules. If the argument points
   at conversation context ("what I just said about naming"), distill from
   that context.
3. If an existing bullet already covers it, bump that bullet's `(seen Nx)`
   count and tighten its wording rather than adding a duplicate. Otherwise add
   a new `(seen 1x)` bullet under the right `## theme` header, creating the
   header only if no existing one fits.
4. If the input is a one-off (specific to the current change, won't recur),
   record nothing and say why.
5. Confirm by quoting the exact headline as recorded or updated.
