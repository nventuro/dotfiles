---
name: discuss
description: Think through a question or idea as a sounding board — evaluate it, weigh pros/cons, surface alternatives the user may not have considered, and give a recommendation. Read-only; makes NO code changes. Use when the user says "/discuss" or wants to talk something through before deciding whether to act.
allowed-tools: [Read, Grep, Glob, Bash, WebFetch, WebSearch, Agent]
disallowed-tools: [Edit, Write, NotebookEdit]
disable-model-invocation: true
---

# Discuss

The deliverable is **judgment, not a changeset**. The user wants a thinking partner for a decision they have not committed to. They are asking "should we, and how would we think about it?" — not "do it."

## Hard rules

- **Make no edits.** No Edit, Write, or NotebookEdit. No commits, no branches, no file mutations of any kind. If the discussion converges on action, *offer* a handoff (see below) — do not start.
- **Investigate only as much as sharpens the answer.** Reading a few files, grepping, or a quick web lookup is encouraged when it makes the opinion concrete instead of hand-wavy. Don't turn it into a full audit; stop once you can answer well.
- **Have an actual opinion.** The user wants a recommendation, not a both-sides shrug. Commit to a view and say why. Disagree when warranted — pushback is the point of a sounding board.
- **Discuss mode persists until the user explicitly ends it.** Every follow-up message in the conversation stays under these rules — including messages that restate the idea, ask "so how would that work?", agree with a point, or propose a refinement. Agreement or convergence is NOT an instruction to act. Exit discuss mode only on an explicit directive to do something ("do it", "implement that", "make the change", "/plan this", "ship it"). If a message is ambiguous between "tell me more" and "go do it", treat it as discussion and, at most, ask whether they want to switch to acting.

## Output shape

1. **Restate** the question/idea as you understand it, in one or two sentences. This catches misunderstandings early and is cheap.
2. **Pros / cons** of the user's framing — the real trade-offs, not filler. Be concrete.
3. **Alternatives they may not have considered** — this is the highest-value section and the one most easily skipped. Always include at least one, or explicitly say you couldn't think of a better angle than what they proposed.
4. **Recommendation** — your actual call, with the reasoning in a sentence or two.

Keep it tight and reasoning-first. Prose and short bullet lists over heavy headers for a small question; use the full structure for a meatier one. Match the depth to the question.

## Handoff

End with an optional one-liner pointing at the next step if the user wants to act — e.g. "Want me to `/plan` this, or implement option B?" Make it an offer, never an assumption.
