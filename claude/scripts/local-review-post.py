#!/usr/bin/env python3
"""local-review-post — read and write the active Local Review session of the
current repository, so review findings can be posted as inline comment threads
and the threads the user hands to Claude acted on.

Each thread has a stage: "todo" (the user's move), "claude" (handed to Claude,
optionally with a "request" of "apply" or "apply-close"), "later" (set aside
until the next round) or "closed" (finished).

Subcommands:
  status         Print JSON about the active review, or {"active": false}.
  ensure-review  Make sure a review is active, creating a "whole branch" one for
                 the current branch if none is, so posting always has a target.
                 No-op when a review is already active.
  pending        List the active review's unfinished work: threads with Claude, and
                 the user's own threads that are not closed.
  archive        Move the active review's threads to its archive/ directory and
                 clear its Reviewed marks, so the next findings start a fresh review.
  post           Read a findings JSON array from stdin and append each as a To do
                 thread to the active review's comments.json (preserving existing
                 threads), skipping findings already posted against the same code.
                 Prints the id of each finding's thread, in input order.
  add-passes     Read [{ "id", "passes" }] from stdin and add those passes to each
                 thread's, for a finding another pass raised too.
  list-actionable  Emit the threads with Claude, sorted by file then line.
  apply-results  Read per-thread outcomes (applied / reply) from stdin, record them
                 in comments.json in one write, and return Later threads to To do.
  stats          Print per-pass finding counts for the active review.

Run from inside the worktree — the .vscode/local-reviews/ files live there.
Threads are written in the Local Review extension's storage format: uuid4 ids,
ISO-millisecond UTC timestamps, 0-based line numbers. Line
numbers crossing this script's interface (findings in, list-actionable out) are
1-based file line numbers, as tools report them. The user runs
"Local Review: Refresh" to see newly posted threads.

Findings (stdin to `post`) is a JSON array; each item:
  { "file"|"filePath": str, "line"|"startLine": int (1-based), "endLine"?: int,
    "body": str (markdown; a "💡 **Suggestion:**" ```diff block applies verbatim),
    "author"?: str (default "team"),
    "passes"?: [str] (the review passes that raised it, e.g. "team" or "codex";
                      default [author]) }
"""

import getpass
import json
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

def _stage(thread):
    """The thread's stage, reading threads saved before stages existed by their
    `state`."""
    return thread.get("stage") or ("closed" if thread.get("state") == "resolved" else "todo")


def _move(thread, stage, request=None):
    """Move a thread to `stage`; only a "claude" thread keeps an apply request."""
    thread["stage"] = stage
    if stage == "claude" and request:
        thread["request"] = request
    else:
        thread.pop("request", None)
    # Superseded by `stage`; left in place they would contradict it.
    thread.pop("state", None)
    thread.pop("disposition", None)


def _add_passes(thread, passes):
    """Record on a thread which review passes raised its finding."""
    thread["passes"] = sorted(set(thread.get("passes") or []) | set(passes))


def _write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


def _now_iso():
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


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


def _make_comment(body, author):
    return {
        "id": str(uuid.uuid4()),
        "body": body,
        "author": author or "team",
        "timestamp": _now_iso(),
    }


def _anchor_code(root, file_path, start, end):
    """The current text of lines start..end (1-based, inclusive) of a repo file,
    or None when the file or the range doesn't exist."""
    try:
        lines = (Path(root) / file_path).read_text().splitlines()
    except Exception:
        return None
    if start < 1 or end < start or end > len(lines):
        return None
    return "\n".join(lines[start - 1:end])


def _finding_keys(file_path, author, body, start, end, anchor_code):
    """Identities under which a posted finding counts as already present: the
    same author raising the same kind of issue (its leading `[tag]`) on the same
    code. Keyed on the code itself when known, so a finding re-raised after its
    code changed is posted again; on the line range otherwise."""
    m = re.match(r"\s*\[([^\]]+)\]", body or "")
    tag = m.group(1).strip().lower() if m else ""
    if anchor_code is not None:
        return {(file_path, author, tag, "code", anchor_code)}
    return {(file_path, author, tag, "lines", start, end)}


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
    per-branch review if none is active. It is keyed the way the extension keys
    a per-branch review (source "review", target <branch>), so the panel adopts it
    on refresh instead of creating a second one. The diff mode ('branch') is just
    the default view; it's not part of the key."""
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


def _load_active(root):
    """(review, comments_path, data) for the active review, or Nones."""
    review, comments_path = _active(root) if root else (None, None)
    if not review:
        return None, None, None
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
    return review, comments_path, data


def _pending(data, user):
    """Threads a fresh review would sweep away mid-flight: ones handed to Claude,
    and the user's own threads that are not closed."""
    out = []
    for t in data.get("threads", []):
        comments = t.get("comments") or []
        stage = _stage(t)
        mine = bool(comments) and comments[0].get("author") == user
        if stage == "claude" or (mine and stage != "closed"):
            out.append({
                "id": t["id"],
                "filePath": t.get("filePath"),
                "line": None if t.get("startLine") is None else t["startLine"] + 1,
                "stage": stage,
                "note": (comments[0].get("body") or "")[:120] if comments else "",
            })
    return out


def cmd_pending():
    root = _repo_root()
    review, _, data = _load_active(root)
    if not review:
        print(json.dumps({"active": False, "pending": []}))
        return 0
    print(json.dumps({"active": True, "pending": _pending(data, getpass.getuser())}, indent=2))
    return 0


def cmd_archive():
    """Archive every thread of the active review, whatever its stage, and clear the
    review's Reviewed marks. Callers check `pending` first: this never refuses."""
    root = _repo_root()
    review, comments_path, data = _load_active(root)
    if not review:
        sys.stderr.write("local-review-post: no active review.\n")
        return 3
    archive_file = None
    n = len(data["threads"])
    if n:
        archive_dir = comments_path.parent / "archive"
        stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
        archive_file = archive_dir / f"{stamp}.json"
        i = 1
        while archive_file.exists():
            i += 1
            archive_file = archive_dir / f"{stamp}-{i}.json"
        _write_json(archive_file, data)
    # Registry first: the extension re-reads it when comments.json changes, so the
    # cleared marks are in place by the time it notices the fresh review.
    reg_path = Path(root) / ".vscode" / "local-reviews" / "registry.json"
    reg = json.loads(reg_path.read_text())
    for r in reg.get("reviews", []):
        if r.get("id") == review["id"]:
            r["reviewedFiles"] = []
            r["reviewedHashes"] = {}
    _write_json(reg_path, reg)
    data["threads"] = []
    _write_json(comments_path, data)
    print(json.dumps({
        "archived": n,
        "archive_file": str(archive_file) if archive_file else None,
        "comments_file": str(comments_path),
    }))
    return 0


def cmd_post():
    root = _repo_root()
    review, comments_path, data = _load_active(root)
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
    # A finding is skipped when an existing thread, in any state, already raises it
    # on the same code: a pass posting in several batches never doubles a thread,
    # and a finding the user discarded stays settled for the rest of the review.
    existing_findings = {}
    for t in data["threads"]:
        if t.get("comments"):
            head = t["comments"][0]
            for key in _finding_keys(
                    t.get("filePath"), head.get("author"), head.get("body"),
                    t.get("startLine"), t.get("endLine"), (t.get("anchor") or {}).get("code")):
                existing_findings[key] = t
    posted = duplicates = 0
    ids = []
    for f in findings:
        fp = f.get("filePath") or f.get("file")
        body = (f.get("body") or "").strip()
        if not fp or not body:
            ids.append(None)
            continue
        comment = _make_comment(body, f.get("author"))
        passes = f.get("passes") or [comment["author"]]
        start = int(f.get("startLine") or f.get("line") or 1)
        end = int(f.get("endLine") or start)
        stored_start, stored_end = start - 1, end - 1
        # The code the finding was raised against, so the extension can keep the
        # thread on it as lines shift and mark it outdated once it changes.
        code = _anchor_code(root, fp, start, end)
        keys = _finding_keys(fp, comment["author"], body, stored_start, stored_end, code)
        legacy = _finding_keys(fp, comment["author"], body, stored_start, stored_end, None)
        existing = next(
            (existing_findings[k] for k in keys | legacy if k in existing_findings), None)
        if existing:
            _add_passes(existing, passes)
            ids.append(existing["id"])
            duplicates += 1
            continue
        thread = {
            "id": str(uuid.uuid4()),
            "filePath": fp,
            "startLine": stored_start,
            "endLine": stored_end,
            "stage": "todo",
            "comments": [comment],
        }
        _add_passes(thread, passes)
        if code is not None:
            thread["anchor"] = {"code": code}
        data["threads"].append(thread)
        ids.append(thread["id"])
        posted += 1
    _write_json(comments_path, data)
    print(json.dumps({
        "posted": posted,
        "duplicates": duplicates,
        "ids": ids,
        "comments_file": str(comments_path),
        "total_threads": len(data["threads"]),
    }))
    return 0


def cmd_add_passes():
    """Record that more passes raised the finding of an existing thread, for a
    finding that is not posted because an equivalent thread already exists.
    Reads a JSON array from stdin; each item: { "id": <threadId>, "passes": [str] }."""
    root = _repo_root()
    review, comments_path, data = _load_active(root)
    if not review:
        sys.stderr.write("local-review-post: no active review.\n")
        return 3
    try:
        items = json.loads(sys.stdin.read())
    except Exception as e:
        sys.stderr.write(f"local-review-post: bad JSON on stdin: {e}\n")
        return 2
    if not isinstance(items, list):
        sys.stderr.write("local-review-post: stdin must be a JSON array.\n")
        return 2

    by_id = {t["id"]: t for t in data["threads"]}
    updated = missing = 0
    for item in items:
        t = by_id.get(item.get("id"))
        if not t:
            missing += 1
            continue
        _add_passes(t, item.get("passes") or [])
        updated += 1
    _write_json(comments_path, data)
    print(json.dumps({"updated": updated, "missing": missing}))
    return 0


def cmd_list_actionable():
    """Emit the threads with Claude, each with everything needed to act on it,
    sorted by file then line so each file needs reading once. `request` is
    "apply-close" or "apply" when the user asked for the thread's change to be made,
    null when they only replied (or, on their own thread, only commented)."""
    root = _repo_root()
    review, comments_path, data = _load_active(root)
    if not review:
        print(json.dumps({"active": False, "threads": []}))
        return 0
    user = getpass.getuser()
    out = []
    for t in data["threads"]:
        comments = t.get("comments", [])
        if _stage(t) != "claude" or not comments:
            continue
        out.append({
            "id": t["id"],
            "filePath": t["filePath"],
            "startLine": None if t.get("startLine") is None else t["startLine"] + 1,
            "endLine": None if t.get("endLine") is None else t["endLine"] + 1,
            "request": t.get("request"),
            "isMine": comments[0].get("author") == user,
            "note": comments[0].get("body"),
            "replies": [
                {"author": c.get("author"), "body": c.get("body")}
                for c in comments[1:]
            ],
            "anchor": (t.get("anchor") or {}).get("code"),
        })
    out.sort(key=lambda x: (x["filePath"], x["startLine"] or 0))
    print(json.dumps(
        {"active": True, "comments_file": str(comments_path), "threads": out}, indent=2))
    return 0


def cmd_apply_results():
    """Record how Claude handled each thread in comments.json in ONE write, then
    return every Later thread to To do: this marks the end of a round.
    Reads a JSON array from stdin; each item:
      { "id": <threadId>, "action": "applied"|"reply", "reply"?: str }
    Semantics (replies are always authored by 'claude'):
      - applied  Claude changed code → applied=true; the thread closes if its request
                 was "apply-close", else goes back to To do. `reply` says what changed.
      - reply    no code change (an answer, pushback or question) → applied=false,
                 back to To do with `reply` appended.
    Never deletes threads."""
    root = _repo_root()
    review, comments_path, data = _load_active(root)
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

    by_id = {t["id"]: t for t in data["threads"]}
    closed = returned = missing = 0
    for r in results:
        t = by_id.get(r.get("id"))
        if not t:
            missing += 1
            continue
        reply = (r.get("reply") or "").strip()
        if r.get("action") == "applied":
            t["applied"] = True
            if t.get("request") == "apply-close":
                _move(t, "closed")
                closed += 1
            else:
                _move(t, "todo")
                returned += 1
        else:
            t["applied"] = False
            _move(t, "todo")
            returned += 1
        if reply:
            t.setdefault("comments", []).append(_make_comment(reply, "claude"))

    from_later = 0
    for t in data["threads"]:
        if _stage(t) == "later":
            _move(t, "todo")
            from_later += 1

    _write_json(comments_path, data)
    print(json.dumps({
        "closed": closed, "returned": returned, "from_later": from_later, "missing": missing,
    }))
    return 0


def cmd_stats():
    """Per-pass finding counts over the active review's threads. A thread counts
    toward every pass that raised its finding, so a finding several passes raised
    is credited to all of them rather than to whichever authored the thread.
    Per pass:
      found      threads it raised
      unique     of those, threads no other pass raised
      applied    of those, threads Claude changed code for
      dismissed  of those, threads closed without a code change
      open       of those, the rest
    `threads` counts the threads any pass raised; threads without `passes` (the
    user's own comments) are left out."""
    root = _repo_root()
    review, _, data = _load_active(root)
    if not review:
        print(json.dumps({"active": False}))
        return 0
    threads = 0
    per_pass = {}
    for t in data["threads"]:
        passes = t.get("passes") or []
        if not passes:
            continue
        threads += 1
        if t.get("applied"):
            outcome = "applied"
        elif _stage(t) == "closed":
            outcome = "dismissed"
        else:
            outcome = "open"
        for p in passes:
            counts = per_pass.setdefault(
                p, {"found": 0, "unique": 0, "applied": 0, "dismissed": 0, "open": 0})
            counts["found"] += 1
            if len(passes) == 1:
                counts["unique"] += 1
            counts[outcome] += 1
    print(json.dumps({"active": True, "threads": threads, "passes": per_pass}, indent=2))
    return 0


def main():
    cmds = ("status", "ensure-review", "pending", "archive", "post", "add-passes",
            "list-actionable", "apply-results", "stats")
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        sys.stderr.write(f"usage: local-review-post.py {{{'|'.join(cmds)}}}\n")
        return 2
    cmd = sys.argv[1]
    if cmd == "status":
        return cmd_status()
    if cmd == "ensure-review":
        return cmd_ensure_review()
    if cmd == "pending":
        return cmd_pending()
    if cmd == "archive":
        return cmd_archive()
    if cmd == "list-actionable":
        return cmd_list_actionable()
    if cmd == "apply-results":
        return cmd_apply_results()
    if cmd == "add-passes":
        return cmd_add_passes()
    if cmd == "stats":
        return cmd_stats()
    return cmd_post()


if __name__ == "__main__":
    sys.exit(main())
