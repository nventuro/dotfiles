#!/usr/bin/env python3
"""SessionStart hook: inject the user's coding preferences.

Reads ~/.claude/local-review/my-learnings.md (the user's own coding
preferences) and emits a compact,
headline-only digest as SessionStart additionalContext — but ONLY when the
session is inside a checkout of one of the repos in config.json (any git repo
when none are configured), so unrelated sessions pay nothing.

Design constraints:
  - Fail-open: any error -> emit nothing, exit 0. Never delay or break session
    start, and never surface a stack trace into the user's session.
  - Headlines only, sorted by (seen Nx) count descending and capped at
    MAX_BULLETS / MAX_CHARS so the injected context stays small; when the file
    holds more, the highest-frequency rules survive.
"""

import json
import re
import subprocess
import sys

from local_review_config import MY_LEARNINGS, load as load_config

MAX_BULLETS = 30
MAX_CHARS = 12000  # ~3k tokens; hard ceiling on injected size

BULLET_RE = re.compile(r"\s*-\s+\*\*(.+?)\*\*\s*(.*)")


def _in_configured_repo(cwd, repos):
    """True if cwd is inside a git repo whose origin remote is one of `repos`
    (`owner/name`); any git repo with an origin when `repos` is empty."""
    try:
        url = subprocess.run(
            ["git", "-C", cwd, "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=2,
        ).stdout.strip()
    except Exception:
        return False
    if not url:
        return False
    if not repos:
        return True
    return any(r.lower() in url.lower() for r in repos)


def _digest():
    """The bold-headline rules (`- **Rule** — short`), sorted by (seen Nx)
    count descending, capped. Each line is the rule plus a short lead of its
    description; quotes and detail are dropped."""
    try:
        text = MY_LEARNINGS.read_text()
    except Exception:
        return ""
    bullets = []
    for line in text.splitlines():
        m = BULLET_RE.match(line)
        if not m:
            continue
        rule = m.group(1).strip()
        rest = m.group(2).strip()
        seen = re.match(r"\(seen\s+(\d+)x", rest)
        count = int(seen.group(1)) if seen else 0
        lead = ""
        if rest:
            after = re.sub(r"^\(seen[^)]*\)\s*", "", rest)  # drop "(seen Nx)"
            after = after.lstrip("-–— ").strip()
            lead = after.split(". ")[0].split(" > ")[0][:120].strip()
        bullets.append((count, f"- {rule}" + (f": {lead}" if lead else "")))
    if not bullets:
        return ""
    bullets.sort(key=lambda b: -b[0])  # stable: ties keep file order
    body = "\n".join(b for _, b in bullets[:MAX_BULLETS])
    if len(body) > MAX_CHARS:
        body = body[:MAX_CHARS].rsplit("\n", 1)[0]
    return body


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    cwd = payload.get("cwd") or "."
    try:
        repos = load_config()["repos"]
    except BaseException:
        return 0
    if not _in_configured_repo(cwd, repos):
        return 0
    digest = _digest()
    if not digest:
        return 0
    context = (
        "The user's coding preferences, learned from their own code reviews. "
        "Treat these as standing review feedback and "
        "follow them while writing code:\n" + digest
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context,
        }
    }))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BaseException:
        sys.exit(0)
