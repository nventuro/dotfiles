#!/usr/bin/env python3
"""Personal settings for the local review kit, kept outside the dotfiles repo in
~/.claude/local-review/config.json:

  {
    "login": "<your GitHub login>",
    "teammates": ["<login>", ...],    whose review patterns /learn-from-prs learns
    "repos": ["<owner>/<name>", ...]  where it learns from, and where the
                                      SessionStart hook injects your learnings
  }

The same directory holds the learnings the reviews read (paths below).
"""
import json
from pathlib import Path

STORE = Path.home() / ".claude" / "local-review"
CONFIG_PATH = STORE / "config.json"
MY_LEARNINGS = STORE / "my-learnings.md"
TEAM_LEARNINGS = STORE / "team-learnings.md"
TEAM_TRACKER = STORE / "team-learnings-tracker.json"


def load():
    """The config as a dict with every key present (empty when unset). Exits
    with a pointer to the file when it is missing or malformed."""
    try:
        cfg = json.loads(CONFIG_PATH.read_text())
    except FileNotFoundError:
        raise SystemExit(f"{CONFIG_PATH} not found; run install.sh to create a template")
    except json.JSONDecodeError as e:
        raise SystemExit(f"{CONFIG_PATH}: invalid JSON ({e})")
    return {
        "login": (cfg.get("login") or "").strip(),
        "teammates": [t for t in (cfg.get("teammates") or []) if t],
        "repos": [r for r in (cfg.get("repos") or []) if r],
    }
