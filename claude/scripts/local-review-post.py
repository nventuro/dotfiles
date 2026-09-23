#!/usr/bin/env python3
"""local-review-post — read/write the active "Local PR Review" session so the
review skills (/review-as-team, /review-as-codex) can post findings as inline
comment threads that /apply-review then applies.

Subcommands:
  status         Print JSON about the active review, or {"active": false}.
  ensure-review  Make sure a review is active, creating a "whole branch" one for
                 the current branch if none is — so /load-pr-comments etc. always
                 have somewhere to post. No-op when a review is already active.
  post           Read a findings JSON array from stdin and append each as a thread
                 to the active review's comments.json (preserving existing threads).
  list-actionable  Emit the threads /apply-review should act on (selection done here,
                 not re-derived by the agent), sorted by file then line.
  apply-results  Read /apply-review's per-thread decisions from stdin and apply them
                 (resolve / applied / reply) to comments.json in one write.

Run from inside the worktree — the .vscode/local-reviews/ files live there. The
written schema mirrors exactly what the extension itself writes: threads with
uuid4 ids, ISO-millisecond UTC timestamps, 1-based line numbers, state
"unresolved". After posting, the user runs "Local PR Review: Refresh" to see
them, then /apply-review applies them.

Findings (stdin to `post`) is a JSON array; each item:
  { "file"|"filePath": str, "line"|"startLine": int, "endLine"?: int,
    "body": str (markdown; a "💡 **Suggestion:**" ```diff block applies verbatim),
    "author"?: str (default "team"),
    "avatarUrl"?: str (e.g. a GitHub avatar; shown as the author's picture) }
A finding may instead carry a "comments" array to seed a multi-comment thread
(e.g. a GitHub review thread with replies):
  { "file": str, "line": int,
    "comments": [ { "body": str, "author"?: str, "avatarUrl"?: str }, ... ] }
"""

import getpass
import json
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Canned bodies the extension posts for triage actions — NOT genuine user replies,
# so list-actionable must not mistake one for fresh feedback.
_CANNED_PREFIXES = ("✅ Queue for apply", "🚫 Skipping", "Applied ✅")


def _is_canned(body):
    b = (body or "").strip()
    return any(b.startswith(p) for p in _CANNED_PREFIXES)


def _now_iso():
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _normalize_ts(ts):
    """An ISO-8601 timestamp (e.g. GitHub's '2026-06-20T12:34:56Z') in the
    ISO-millisecond-UTC form the extension stores, or None if empty/unusable."""
    if not isinstance(ts, str) or not ts.strip():
        return None
    s = ts.strip()
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"
    except ValueError:
        return s  # non-empty but unparseable — pass through; new Date() may still read it


def _arg_value(flag):
    """Value of a `--flag value` or `--flag=value` option in argv (or None)."""
    argv = sys.argv[2:]
    for i, a in enumerate(argv):
        if a == flag and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith(flag + "="):
            return a[len(flag) + 1:]
    return None


def _repo_root():
    try:
        return subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True,
        ).stdout.strip()
    except Exception:
        return ""


def _review_dir_name(source, target):
    # The extension names the dir "<source>_<target>" with each branch's "/" -> "-".
    return f"{source.replace('/', '-')}_{target.replace('/', '-')}"


def _make_comment(body, author, avatar_url, channel="local", comment_id=None, timestamp=None):
    c = {
        "id": str(uuid.uuid4()),
        "body": body,
        "author": author or "team",
        # A real source timestamp (GitHub's created_at) when given, else now.
        "timestamp": _normalize_ts(timestamp) or _now_iso(),
        "channel": channel,
    }
    if avatar_url:
        c["avatarUrl"] = avatar_url
    # The source comment's GitHub id (review-comment databaseId), kept so a re-sync
    # can append replies added to an already-loaded thread without duplicating.
    if comment_id is not None:
        c["commentId"] = comment_id
    return c


def _build_comments(f):
    """Comment list for a finding: a multi-comment `comments` array if given, else
    the single body/author/avatarUrl form. Empty-bodied entries are dropped. Each
    comment's channel comes from the source (github-pr-to-findings tags 'github');
    everything else defaults to 'local'."""
    raw = f.get("comments")
    if isinstance(raw, list) and raw:
        out = []
        for c in raw:
            body = (c.get("body") or "").strip()
            if body:
                out.append(_make_comment(body, c.get("author"), c.get("avatarUrl"),
                                         c.get("channel", "local"), c.get("commentId"),
                                         c.get("timestamp")))
        return out
    body = (f.get("body") or "").strip()
    if not body:
        return []
    return [_make_comment(body, f.get("author"), f.get("avatarUrl"),
                          f.get("channel", "local"), f.get("commentId"),
                          f.get("timestamp"))]


def _active(root):
    """(review_dict, comments_path) for the active review, or (None, None)."""
    reg_path = Path(root) / ".vscode" / "local-reviews" / "registry.json"
    try:
        reg = json.loads(reg_path.read_text())
    except Exception:
        return None, None
    active_id = reg.get("activeReviewId")
    review = next((r for r in reg.get("reviews", []) if r.get("id") == active_id), None)
    if not review:
        return None, None
    d = _review_dir_name(review["sourceBranch"], review["targetBranch"])
    return review, Path(root) / ".vscode" / "local-reviews" / d / "comments.json"


def _git(root, *args):
    return subprocess.run(
        ["git", "-C", root, *args], capture_output=True, text=True
    ).stdout.strip()


def _ensure_review(root):
    """(review, comments_path) for the active review, creating the single
    per-branch review if none is active. Mirrors the extension's
    ensureReview(<branch>) — same synthetic key (review / <branch>) and fields —
    so the panel ADOPTS it on refresh instead of forking a second review. The
    diff mode ('branch') is just the default view; it's not part of the key."""
    review, comments_path = _active(root)
    if review:
        return review, comments_path

    reg_path = Path(root) / ".vscode" / "local-reviews" / "registry.json"
    try:
        reg = json.loads(reg_path.read_text())
    except Exception:
        reg = {"version": 1, "reviews": []}
    reg.setdefault("version", 1)
    reg.setdefault("reviews", [])

    source = "review"
    target = _git(root, "rev-parse", "--abbrev-ref", "HEAD")
    if not target or target == "HEAD":
        # Detached HEAD / git not resolvable — refuse to fork a review keyed on the
        # literal 'HEAD'. Such a ghost orphans the real branch's review once the
        # branch resolves normally again, silently losing its comments.
        return None, None

    existing = next(
        (r for r in reg["reviews"]
         if r.get("sourceBranch") == source and r.get("targetBranch") == target),
        None,
    )
    if existing:
        existing["mode"] = "branch"
        review = existing
    else:
        head = _git(root, "rev-parse", "HEAD")
        review = {
            "id": str(uuid.uuid4()),
            "sourceBranch": source,
            "targetBranch": target,
            "sourceCommit": head,
            "targetCommit": head,
            "createdAt": _now_iso(),
            "mode": "branch",
        }
        reg["reviews"].append(review)
    reg["activeReviewId"] = review["id"]

    reg_path.parent.mkdir(parents=True, exist_ok=True)
    reg_path.write_text(json.dumps(reg, indent=2))

    d = _review_dir_name(source, target)
    return review, Path(root) / ".vscode" / "local-reviews" / d / "comments.json"


def cmd_ensure_review():
    root = _repo_root()
    if not root:
        print(json.dumps({"active": False, "error": "not a git repo"}))
        return 1
    review, comments_path = _ensure_review(root)
    if not review:
        print(json.dumps({"active": False,
                          "error": "could not resolve current branch (detached HEAD?) — "
                                   "refusing to create a 'HEAD'-keyed review"}))
        return 1
    print(json.dumps({
        "active": True,
        "comments_file": str(comments_path),
        "sourceBranch": review["sourceBranch"],
        "targetBranch": review["targetBranch"],
        "mode": review.get("mode"),
    }))
    return 0


def cmd_status():
    root = _repo_root()
    if not root:
        print(json.dumps({"active": False, "error": "not a git repo"}))
        return 0
    review, comments_path = _active(root)
    if not review:
        print(json.dumps({"active": False}))
        return 0
    try:
        n = len(json.loads(comments_path.read_text()).get("threads", []))
    except Exception:
        n = 0
    print(json.dumps({
        "active": True,
        "comments_file": str(comments_path),
        "sourceBranch": review["sourceBranch"],
        "targetBranch": review["targetBranch"],
        "reviewedFiles": review.get("reviewedFiles", []),
        "thread_count": n,
    }))
    return 0


def cmd_post():
    root = _repo_root()
    review, comments_path = _active(root) if root else (None, None)
    if not review:
        sys.stderr.write(
            "local-review-post: no active review. Create one in the Local PR "
            "Review panel first.\n")
        return 3
    try:
        findings = json.loads(sys.stdin.read())
    except Exception as e:
        sys.stderr.write(f"local-review-post: bad findings JSON on stdin: {e}\n")
        return 2
    if not isinstance(findings, list):
        sys.stderr.write("local-review-post: stdin must be a JSON array.\n")
        return 2
    try:
        data = json.loads(comments_path.read_text())
    except Exception:
        data = {
            "version": 1,
            "sourceBranch": review["sourceBranch"],
            "targetBranch": review["targetBranch"],
            "sourceCommit": review.get("sourceCommit", ""),
            "targetCommit": review.get("targetCommit", ""),
            "threads": [],
        }
    data.setdefault("threads", [])
    # Your GitHub login (passed by /load-pr-comments). Stored once so the extension
    # treats comments you wrote on the PR as yours — keeping your own FYI notes out
    # of the triage "needs your OK" queue. Preserved across re-syncs.
    viewer_login = _arg_value("--viewer-login")
    if not viewer_login:
        # Fall back to the configured login, never the PR author (which is wrong
        # whenever you're reviewing someone else's PR — it would mark THEIR
        # comments as yours).
        try:
            from local_review_config import load as load_config
            viewer_login = load_config()["login"] or None
        except BaseException:
            viewer_login = None
    if viewer_login:
        data["viewerLogin"] = viewer_login
    # Idempotent upsert keyed by the thread's head GitHub comment id. A thread that
    # is already loaded is not re-created (preserving its local state / disposition /
    # applied), but any replies added to it on GitHub since the last sync ARE merged
    # in — so re-syncing a PR picks up new replies without duplicating threads or
    # comments. Non-GitHub findings always append as fresh threads.
    by_comment = {}
    for t in data["threads"]:
        cid = (t.get("github") or {}).get("commentId")
        if cid is not None:
            by_comment[cid] = t
    posted = skipped = merged = repaired = 0
    for f in findings:
        fp = f.get("filePath") or f.get("file")
        comments = _build_comments(f)
        if not fp or not comments:
            continue
        gh = f.get("github")
        cid = (gh or {}).get("commentId")
        if cid is not None and cid in by_comment:
            # Thread exists: append only comments not already present. Match on the
            # per-comment GitHub id when both sides have it, else fall back to
            # (author, body) so threads loaded before commentId was tracked, and any
            # local-only replies, are not duplicated.
            existing = by_comment[cid]["comments"]
            seen_ids = {c["commentId"] for c in existing if c.get("commentId") is not None}
            seen_bodies = {(c.get("author"), (c.get("body") or "").strip()) for c in existing}
            added = False
            for c in comments:
                ccid = c.get("commentId")
                if ccid is not None and ccid in seen_ids:
                    continue
                if (c.get("author"), (c.get("body") or "").strip()) in seen_bodies:
                    continue
                existing.append(c)
                if ccid is not None:
                    seen_ids.add(ccid)
                seen_bodies.add((c.get("author"), (c.get("body") or "").strip()))
                merged += 1
                added = True
            # Repair timestamps on already-loaded comments: earlier loads stamped them
            # with the import time ("3 min ago"); refresh to the real GitHub created_at
            # (matched per-comment by GitHub id).
            new_ts = {c["commentId"]: c["timestamp"]
                      for c in comments if c.get("commentId") is not None}
            for ec in existing:
                ecid = ec.get("commentId")
                if ecid in new_ts and ec.get("timestamp") != new_ts[ecid]:
                    ec["timestamp"] = new_ts[ecid]
                    added = True
                    repaired += 1
            # Repair/refresh the anchor from the diff_hunk on re-sync: it's the
            # reliable original code, and existing threads may have none (or a wrong
            # one a previous version guessed from the working file).
            anchor = f.get("anchor")
            if anchor and by_comment[cid].get("anchor") != anchor:
                by_comment[cid]["anchor"] = anchor
                added = True
                repaired += 1
            if not added:
                skipped += 1
            continue
        start = int(f.get("startLine") or f.get("line") or 1)
        end = int(f.get("endLine") or start)
        thread = {
            "id": str(uuid.uuid4()),
            "filePath": fp,
            "startLine": start,
            "endLine": end,
            "state": "unresolved",
            "comments": comments,
        }
        if gh:
            thread["github"] = gh
        if f.get("anchor"):
            thread["anchor"] = f["anchor"]
        data["threads"].append(thread)
        if cid is not None:
            by_comment[cid] = thread
        posted += 1
    comments_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = comments_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(comments_path)
    print(json.dumps({
        "posted": posted,
        "merged": merged,
        "skipped": skipped,
        "repaired": repaired,
        "comments_file": str(comments_path),
        "total_threads": len(data["threads"]),
    }))
    return 0


def cmd_list_actionable():
    """Emit the threads /apply-review should act on, so the agent doesn't re-scan or
    re-derive the selection. Each carries everything needed to decide + edit, sorted
    by file then line so the agent reads each file once. Selection:
      - `reason: "apply"`  unresolved, not applied, AND (you authored it OR it's a
                           not-yours thread you queued, disposition=accepted).
      - `reason: "reply"`  unresolved, and its LAST comment is a fresh reply from you
                           (your channel-local note, not a canned/Applied one) on a
                           thread that's otherwise done (applied) or never queued.
                           This is the "new reply re-opens it" case.
    Resolved threads, un-queued not-yours threads with no reply, and applied threads
    with no new reply are omitted. A thread whose LAST comment is Claude's is also
    omitted — Claude already responded and is waiting on you, so a run never piles a
    second comment onto a thread you haven't answered."""
    root = _repo_root()
    review, comments_path = _active(root) if root else (None, None)
    if not review:
        print(json.dumps({"active": False, "threads": []}))
        return 0
    user = getpass.getuser()
    try:
        data = json.loads(comments_path.read_text())
    except Exception:
        print(json.dumps({"active": True, "comments_file": str(comments_path), "threads": []}))
        return 0

    out = []
    for t in data.get("threads", []):
        if t.get("state") == "resolved":
            continue
        comments = t.get("comments", [])
        if not comments:
            continue
        head_author = comments[0].get("author")
        last = comments[-1]
        # Claude already had the last word here — it applied / replied / pushed back /
        # asked, and is now waiting on you. Don't re-select the thread until you
        # respond, so a later run doesn't keep piling comments onto a thread you
        # haven't answered yet. Your next comment makes `last` yours again and
        # re-opens it (fresh_reply below).
        if last.get("author") == "claude":
            continue
        applied = bool(t.get("applied"))
        pending_apply = (not applied) and (
            head_author == user or t.get("disposition") == "accepted")
        fresh_reply = (
            last.get("author") == user
            and (last.get("channel") or "local") == "local"
            and not _is_canned(last.get("body")))
        if pending_apply:
            reason = "apply"
        elif fresh_reply:
            reason = "reply"
        else:
            continue
        out.append({
            "id": t["id"],
            "filePath": t["filePath"],
            "startLine": t.get("startLine"),
            "endLine": t.get("endLine"),
            "reason": reason,
            "isMine": head_author == user,
            "isGithub": bool(t.get("github")),
            "applied": applied,
            "disposition": t.get("disposition"),
            "note": comments[0].get("body"),
            "replies": [
                {"author": c.get("author"), "channel": c.get("channel") or "local",
                 "body": c.get("body")}
                for c in comments[1:]
            ],
            "anchor": (t.get("anchor") or {}).get("code"),
        })
    out.sort(key=lambda x: (x["filePath"], x["startLine"] or 0))
    print(json.dumps(
        {"active": True, "comments_file": str(comments_path), "threads": out}, indent=2))
    return 0


def cmd_apply_results():
    """Apply /apply-review's per-thread decisions to comments.json in ONE write, so
    the agent doesn't hand-edit the file (and generate ids/timestamps) per thread.
    Reads a JSON array from stdin; each item:
      { "id": <threadId>, "action": "resolve"|"applied"|"reply", "reply"?: str }
    Semantics (replies are always author 'claude', channel 'local'):
      - resolve  your own thread you applied → state=resolved; append `reply` if any.
      - applied  not-yours thread you applied → applied=true, state stays unresolved;
                 append an "Applied ✅ — <reply>" note.
      - reply    pushback / question / answer → append `reply`, state stays unresolved.
    Never deletes threads or touches other fields."""
    root = _repo_root()
    review, comments_path = _active(root) if root else (None, None)
    if not review:
        sys.stderr.write("local-review-post: no active review.\n")
        return 3
    try:
        results = json.loads(sys.stdin.read())
    except Exception as e:
        sys.stderr.write(f"local-review-post: bad results JSON on stdin: {e}\n")
        return 2
    if not isinstance(results, list):
        sys.stderr.write("local-review-post: stdin must be a JSON array.\n")
        return 2
    try:
        data = json.loads(comments_path.read_text())
    except Exception as e:
        sys.stderr.write(f"local-review-post: can't read comments file: {e}\n")
        return 2

    by_id = {t["id"]: t for t in data.get("threads", [])}
    resolved = applied = replied = missing = 0
    for r in results:
        t = by_id.get(r.get("id"))
        if not t:
            missing += 1
            continue
        action = r.get("action")
        reply = (r.get("reply") or "").strip()
        comments = t.setdefault("comments", [])
        if action == "resolve":
            t["state"] = "resolved"
            resolved += 1
            if reply:
                comments.append(_make_comment(reply, "claude", None, "local"))
        elif action == "applied":
            t["applied"] = True
            applied += 1
            note = reply if reply.startswith("Applied ✅") else (
                f"Applied ✅ — {reply}" if reply else "Applied ✅")
            comments.append(_make_comment(note, "claude", None, "local"))
        else:  # "reply" (or anything with a body to add)
            if reply:
                comments.append(_make_comment(reply, "claude", None, "local"))
                replied += 1

    tmp = comments_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(comments_path)
    print(json.dumps({
        "resolved": resolved, "applied": applied, "replied": replied, "missing": missing,
    }))
    return 0


def main():
    cmds = ("status", "ensure-review", "post", "list-actionable", "apply-results")
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        sys.stderr.write(f"usage: local-review-post.py {{{'|'.join(cmds)}}}\n")
        return 2
    cmd = sys.argv[1]
    if cmd == "status":
        return cmd_status()
    if cmd == "ensure-review":
        return cmd_ensure_review()
    if cmd == "list-actionable":
        return cmd_list_actionable()
    if cmd == "apply-results":
        return cmd_apply_results()
    return cmd_post()


if __name__ == "__main__":
    sys.exit(main())
