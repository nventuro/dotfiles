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
    MAX_BULLETS / MAX_CHARS so the injected context stays bounded; when the
    file holds more, the highest-frequency rules survive.

`inject-learnings.py check` prints a warning when the caps leave rules out, and
nothing otherwise, for a caller to show once the user is reading: a warning at
session start scrolls by before the user reads it, and the rules left out would
vanish unnoticed. Unlike the hook, check fails loudly: a caller would read a
check that failed silently as one with nothing to warn about.
"""

import json
import re
import subprocess
import sys

from local_review_config import MY_LEARNINGS, load as load_config

# We're injecting all of these into the session, so we want to prevent unbounded growth.
MAX_BULLETS = 300
# Room for MAX_BULLETS lines of a headline plus a lead of at most 120 chars, so
# the bullet cap is the one that binds.
MAX_CHARS = MAX_BULLETS * 250

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
    count descending, capped, and how many rules the caps left out. Each line
    is the rule plus a short lead of its description; quotes and detail are
    dropped."""
    text = MY_LEARNINGS.read_text()
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
        return "", 0
    bullets.sort(key=lambda b: -b[0])  # stable: ties keep file order
    body = "\n".join(b for _, b in bullets[:MAX_BULLETS])
    if len(body) > MAX_CHARS:
        body = body[:MAX_CHARS].rsplit("\n", 1)[0]
    return body, len(bullets) - len(body.splitlines())


def _check():
    """Print a warning when the caps leave rules out of the digest."""
    _, left_out = _digest()
    if left_out:
        print(
            f"{MY_LEARNINGS} holds more than the session digest fits "
            f"({MAX_BULLETS} rules, {MAX_CHARS} characters): its {left_out} "
            "lowest-count rules are not injected."
        )
    return 0


def main():
    if sys.argv[1:] == ["check"]:
        return _check()
    if sys.argv[1:]:
        print(f"usage: {sys.argv[0]} [check]", file=sys.stderr)
        return 2
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
    digest, _ = _digest()
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
        status = main()
    except BaseException:
        if sys.argv[1:]:  # only the hook, run with no arguments, fails open
            raise
        status = 0
    sys.exit(status)
