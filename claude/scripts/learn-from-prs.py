#!/usr/bin/env python3
"""
Fetch and filter high-signal PRs for review pattern analysis.

Usage:
  learn-from-prs.py fetch [--since YYYY-MM-DD]
    Fetch merged PRs across the configured repos, filter to high-signal,
    output all unprocessed ones. Each entry carries the repo it came from.
    --since bounds the search (default: the last 180 days).

  learn-from-prs.py fetch-comments [--out-dir DIR] <repo#pr> [<repo#pr> ...]
    Fetch the teammates' review bodies, discussion comments and inline
    comments on specific PRs, excluding the PR author's own. PRs with none
    are left out. With --out-dir, writes them to DIR/comments-batchN.json in
    batches sized for one map-stage agent each and prints the batch list;
    otherwise prints them all. A bare number is read as a PR in the first
    configured repo.

Reads tracker from TRACKER_PATH env var (or default).
Outputs JSON to stdout, progress to stderr.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

from datetime import date, timedelta

from local_review_config import TEAM_TRACKER, load as load_config

_config = load_config()
# The user plus the teammates whose reviews we learn from.
AUTHORS = [_config["login"], *_config["teammates"]]
TEAMMATES = set(_config["teammates"])
# PRs are identified as "<repo>#<number>" throughout, because PR numbers
# collide across repos.
REPOS = _config["repos"]
if not AUTHORS[0] or not REPOS:
    sys.exit("config.json needs at least `login` and one entry in `repos`")
DEFAULT_REPO = REPOS[0]

# Bounds the first fetch: scoring a PR costs two gh calls, so an unbounded
# history of every author's merged PRs would take a long time.
DEFAULT_SINCE_DAYS = 180
DEFAULT_TRACKER = str(TEAM_TRACKER)

# GitHub's diff hunk ends at the commented line but can start hundreds of lines
# above it, and it dominates the size of the review data.
HUNK_TAIL_LINES = 8
# Sized so a map-stage agent can read a whole batch and emit a bullet per
# comment within its context and output limits.
MAX_BATCH_COMMENTS = 100
MAX_BATCH_CHARS = 100_000


def log(msg):
    print(msg, file=sys.stderr)


def pr_key(repo, number):
    return f"{repo}#{number}"


def parse_pr_key(arg):
    """Parse "<owner>/<repo>#<n>"; a bare number means DEFAULT_REPO."""
    if "#" in arg:
        repo, num = arg.rsplit("#", 1)
        return repo, int(num)
    return DEFAULT_REPO, int(arg)


def run_gh(args, timeout=30):
    result = subprocess.run(
        ["gh"] + args, capture_output=True, text=True, timeout=timeout
    )
    if result.returncode != 0:
        log(f"  gh error: {result.stderr.strip()}")
        return None
    return result.stdout.strip()


def read_tracker():
    path = os.environ.get("TRACKER_PATH", DEFAULT_TRACKER)
    try:
        with open(path) as f:
            tracker = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"processed": [], "last_run": None}
    tracker["processed"] = list(tracker.get("processed", []))
    return tracker


def fetch_prs_for_author(repo, author, since_date):
    """Fetch merged PRs authored by a given user since the given date."""
    out = run_gh([
        "pr", "list", "--repo", repo, "--state", "merged",
        "--search", f"merged:>={since_date} author:{author}",
        "--json", "number,title,author,mergedAt,reviewDecision",
        "--limit", "999",
    ], timeout=60)
    if out is None:
        return []
    return json.loads(out)


def check_signal_count(repo, pr_number):
    """Check review + comment count from non-author for a PR.

    Inline comments are counted because repos differ in where the substance
    lands: some teams write many review submissions and discussion comments,
    others approve once and put every real remark in an inline comment.
    """
    out = run_gh([
        "pr", "view", str(pr_number), "--repo", repo,
        "--json", "reviews,comments,author",
    ], timeout=30)
    if out is None:
        return 0
    d = json.loads(out)
    author = d["author"]["login"]
    n_reviews = len([
        r for r in d.get("reviews", [])
        if r["author"]["login"] != author
    ])
    n_comments = len([
        c for c in d.get("comments", [])
        if c["author"]["login"] != author
    ])
    n_inline = len([
        c for c in fetch_inline_comments(repo, pr_number)
        if c["user"] != author
    ])
    return n_reviews + n_comments + n_inline


def fetch_inline_comments(repo, pr_number):
    """Fetch inline review comments for a PR."""
    out = run_gh([
        "api", f"repos/{repo}/pulls/{pr_number}/comments", "--paginate",
    ], timeout=30)
    if out is None:
        return []
    try:
        comments = json.loads(out)
    except json.JSONDecodeError:
        return []
    # Filter to substantive comments
    return [
        {
            "user": c.get("user", {}).get("login", "unknown"),
            "body": c.get("body", ""),
            "path": c.get("path", ""),
            "line": c.get("line") or c.get("original_line"),
            "diff_hunk": "\n".join(
                c.get("diff_hunk", "").splitlines()[-HUNK_TAIL_LINES:]
            ),
        }
        for c in comments
        if c.get("body", "").strip()
        and not c.get("user", {}).get("login", "").endswith("[bot]")
    ]


def fetch_pr_reviews_and_comments(repo, pr_number):
    """Fetch review bodies + PR discussion comments via gh pr view."""
    out = run_gh([
        "pr", "view", str(pr_number), "--repo", repo,
        "--json", "reviews,comments,author,title",
    ], timeout=30)
    if out is None:
        return {"reviews": [], "comments": [], "author": "?", "title": "?"}
    return json.loads(out)


def cmd_fetch(since):
    tracker = read_tracker()
    processed = set(tracker["processed"])

    last_run = tracker.get("last_run")

    def since_for(repo):
        # A repo with nothing processed yet has never been learned from, so
        # its history is fetched from the start regardless of last_run.
        seen = any(p.startswith(f"{repo}#") for p in processed)
        if last_run and seen:
            return last_run[:10]
        return since

    log(f"Fetching PRs for {len(AUTHORS)} authors across {len(REPOS)} repos...")
    all_prs = {}
    for repo in REPOS:
        since_date = since_for(repo)
        log(f"{repo} (merged since {since_date}):")
        for author in AUTHORS:
            prs = fetch_prs_for_author(repo, author, since_date)
            for pr in prs:
                all_prs[pr_key(repo, pr["number"])] = {**pr, "repo": repo}
            log(f"  {author}: {len(prs)} PRs")

    log(f"Total unique PRs: {len(all_prs)}")

    # Filter out already processed
    unprocessed = {
        k: p for k, p in all_prs.items() if k not in processed
    }
    log(f"After removing {len(processed)} processed: {len(unprocessed)}")

    filtered = unprocessed

    # Check comment counts for signal
    log("Checking review signal for each PR...")
    high_signal = []
    sorted_keys = sorted(
        filtered.keys(), key=lambda k: filtered[k]["mergedAt"], reverse=True
    )
    for i, key in enumerate(sorted_keys):
        pr = filtered[key]
        count = check_signal_count(pr["repo"], pr["number"])
        if count >= 3:
            high_signal.append({
                "key": key,
                "repo": pr["repo"],
                "number": pr["number"],
                "signal": count,
                "title": pr["title"],
                "author": pr["author"]["login"],
            })
            log(f"  [{i+1}/{len(sorted_keys)}] {key} -> "
                f"{count} signals (HIGH)")
        elif (i + 1) % 25 == 0:
            log(f"  [{i+1}/{len(sorted_keys)}] checked...")

    # Every high-signal PR is returned: the next fetch only searches PRs merged
    # after this run, so any left out here would never be learned from.
    high_signal.sort(key=lambda x: -x["signal"])

    log(f"\nHigh-signal: {len(high_signal)}")
    json.dump(high_signal, sys.stdout, indent=2)


def fetch_teammate_comments(repo, pr_number):
    """The PR's title and author plus the review bodies, discussion comments
    and inline comments teammates left on it, excluding the author's own."""
    pr_data = fetch_pr_reviews_and_comments(repo, pr_number)
    author = pr_data.get("author", {}).get("login", "?")

    def by_teammate(user, body):
        return user in TEAMMATES and user != author and body.strip()

    return {
        "repo": repo,
        "number": pr_number,
        "title": pr_data.get("title", "?"),
        "author": author,
        "reviews": [
            {
                "user": r["author"]["login"],
                "state": r["state"],
                "body": r.get("body", ""),
            }
            for r in pr_data.get("reviews", [])
            if by_teammate(r["author"]["login"], r.get("body", ""))
        ],
        "comments": [
            {
                "user": c["author"]["login"],
                "body": c["body"],
            }
            for c in pr_data.get("comments", [])
            if by_teammate(c["author"]["login"], c["body"])
        ],
        "inline_comments": [
            c for c in fetch_inline_comments(repo, pr_number)
            if by_teammate(c["user"], c["body"])
        ],
    }


def comment_count(pr):
    return len(pr["reviews"]) + len(pr["comments"]) + len(pr["inline_comments"])


def pack_batches(prs):
    """Groups PRs into batches within the comment and size budgets. PRs are
    never split, so a PR over budget on its own gets a batch to itself."""
    batches, batch, n_comments, n_chars = [], {}, 0, 0
    for key, pr in prs.items():
        pr_comments, pr_chars = comment_count(pr), len(json.dumps(pr))
        if batch and (n_comments + pr_comments > MAX_BATCH_COMMENTS
                      or n_chars + pr_chars > MAX_BATCH_CHARS):
            batches.append(batch)
            batch, n_comments, n_chars = {}, 0, 0
        batch[key] = pr
        n_comments += pr_comments
        n_chars += pr_chars
    if batch:
        batches.append(batch)
    return batches


def cmd_fetch_comments(prs, out_dir):
    results = {}
    for i, (repo, num) in enumerate(prs):
        key = pr_key(repo, num)
        log(f"[{i+1}/{len(prs)}] Fetching {key}...")
        pr = fetch_teammate_comments(repo, num)
        if comment_count(pr):
            results[key] = pr
    log(f"{len(results)} of {len(prs)} PRs have teammate comments")

    if out_dir is None:
        json.dump(results, sys.stdout, indent=2)
        return

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    summary = []
    for n, batch in enumerate(pack_batches(results), 1):
        path = out / f"comments-batch{n}.json"
        path.write_text(json.dumps(batch, indent=1))
        summary.append({
            "path": str(path),
            "prs": len(batch),
            "comments": sum(comment_count(pr) for pr in batch.values()),
        })
    json.dump(summary, sys.stdout, indent=2)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "fetch":
        since = (date.today() - timedelta(days=DEFAULT_SINCE_DAYS)).isoformat()
        args = sys.argv[2:]
        for i, arg in enumerate(args):
            if arg == "--since" and i + 1 < len(args):
                since = args[i + 1]
        cmd_fetch(since)
    elif cmd == "fetch-comments":
        args = sys.argv[2:]
        out_dir = None
        if "--out-dir" in args:
            i = args.index("--out-dir")
            out_dir = args[i + 1]
            del args[i:i + 2]
        prs = [parse_pr_key(x) for x in args]
        if not prs:
            log("No PRs provided")
            sys.exit(1)
        cmd_fetch_comments(prs, out_dir)
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
