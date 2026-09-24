#!/usr/bin/env python3
"""github-pr-to-findings — turn a GitHub PR's inline review comments
(`GET /repos/:o/:r/pulls/:n/comments` JSON) into local review findings: a JSON
array of threads, each with a file, a line range, and its comments.

What it does:
  * groups reply chains (in_reply_to_id) into a single thread;
  * drops threads written entirely by review bots;
  * maps each reviewer to author=login + avatarUrl=avatar_url;
  * rewrites GitHub ```suggestion blocks into the suggested-change form review
    threads use — `💡 **Suggestion:**` + a ```diff block with `- <original>` /
    `+ <suggested>` lines — using the comment's diff_hunk for the original
    line(s), so they render as a diff and can be applied verbatim.

Usage: github-pr-to-findings.py [comments.json]   (reads stdin if no path).
Emits the findings JSON on stdout.
"""
import json
import re
import sys

# ```suggestion[optional junk]\n<content>``` — content is the replacement text.
SUGGESTION_RE = re.compile(r"```suggestion[^\n]*\n(.*?)```", re.DOTALL)

# repos/<owner>/<name>/pulls/<n> out of a review comment's pull_request_url.
PR_URL_RE = re.compile(r"/repos/([^/]+/[^/]+)/pulls/(\d+)")


def _github_ref(comment):
    """{repo, prNumber, commentId} for a review comment — the stable identity kept
    on the thread, so importing the PR again updates it instead of duplicating it.
    commentId is the REST databaseId."""
    m = PR_URL_RE.search(comment.get("pull_request_url") or "")
    if not m:
        return None
    return {"repo": m.group(1), "prNumber": int(m.group(2)), "commentId": comment.get("id")}


def _is_bot(comment):
    user = comment.get("user") or {}
    return user.get("type") == "Bot" or (user.get("login") or "").endswith("[bot]")


def _new_side_lines(diff_hunk):
    """Hunk lines that exist on the new (current-file) side, prefix-stripped.
    Context (' ') and additions ('+') are on the new side; removals ('-') and
    the `@@` header are not."""
    out = []
    for ln in diff_hunk.splitlines():
        if ln.startswith("@@"):
            continue
        marker = ln[:1]
        if marker == "-":
            continue
        out.append(ln[1:] if marker in (" ", "+") else ln)
    return out


def _original_lines(comment):
    """The file line(s) the comment is anchored to, taken from diff_hunk: its
    last new-side line is the commented line; a multi-line comment
    (start_line..line) spans the last N. Returns None if no usable hunk."""
    hunk = comment.get("diff_hunk") or ""
    new_side = _new_side_lines(hunk)
    if not new_side:
        return None
    start = comment.get("start_line")
    line = comment.get("line") or comment.get("original_line")
    n = 1
    if start and line and line >= start:
        n = line - start + 1
    return new_side[-min(n, len(new_side)):]


def _convert_suggestions(comment):
    """Rewrite any ```suggestion blocks in the comment body to the extension's
    ```diff suggestion form. Leaves the body untouched if there's no suggestion
    or no diff_hunk to recover the original line(s) from."""
    body = comment.get("body", "") or ""
    if "```suggestion" not in body:
        return body
    originals = _original_lines(comment)

    def repl(m):
        if originals is None:
            return m.group(0)  # no original to diff against — leave as-is
        sugg = m.group(1).split("\n")
        if sugg and sugg[-1] == "":
            sugg = sugg[:-1]
        diff = [f"- {l}" for l in originals] + [f"+ {l}" for l in sugg]
        return "💡 **Suggestion:**\n\n```diff\n" + "\n".join(diff) + "\n```"

    return SUGGESTION_RE.sub(repl, body)


def main():
    raw = open(sys.argv[1]).read() if len(sys.argv) > 1 else sys.stdin.read()
    comments = json.loads(raw)

    # Group into threads: a reply carries in_reply_to_id pointing at the head
    # comment's id; a head comment has none. GitHub returns these chronologically,
    # so the head is the first comment seen for its key.
    threads, order = {}, []
    for c in comments:
        key = c.get("in_reply_to_id") or c["id"]
        if key not in threads:
            threads[key] = []
            order.append(key)
        threads[key].append(c)

    findings = []
    for key in order:
        cs = threads[key]
        # A review bot's thread matters only once a person has engaged with it.
        if all(_is_bot(c) for c in cs):
            continue
        head = cs[0]
        path = head.get("path")
        if not path:
            continue  # outdated comment with no current location; skip
        # Keep the comment's full row range: GitHub gives `start_line`..`line` for a
        # multi-line comment (`start_line` is null for a single-line one). Collapsing
        # to just `line` loses which rows the comment actually spans.
        end_line = head.get("line") or head.get("original_line") or 1
        start_line = head.get("start_line") or head.get("original_start_line") or end_line
        finding = {
            "filePath": path,
            "startLine": start_line,
            "endLine": end_line,
            "comments": [{
                "body": _convert_suggestions(x),
                "author": (x.get("user") or {}).get("login", "reviewer"),
                "avatarUrl": (x.get("user") or {}).get("avatar_url"),
                "channel": "github",
                "commentId": x.get("id"),
                # When the comment was posted, not when it was imported. created_at
                # rather than updated_at, which jumps on an edit.
                "timestamp": x.get("created_at"),
            } for x in cs],
        }
        ref = _github_ref(head)
        if ref:
            finding["github"] = ref
        # The code the comment was actually written against, straight from GitHub's
        # diff_hunk. This is the reliable "original" — it survives local line drift
        # (the stored line can be a stale `original_line` once the comment goes
        # outdated on GitHub) and an edit applied since. Drives the "outdated" bubble.
        orig = _original_lines(head)
        if orig:
            finding["anchor"] = {"code": "\n".join(orig)}
        findings.append(finding)

    json.dump(findings, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
