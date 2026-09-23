import * as vscode from 'vscode';

/**
 * A review is one of two modes:
 *  - 'uncommitted': working-tree changes vs HEAD, split into staged/unstaged/untracked.
 *  - 'branch': the whole current branch vs its inferred base (merge-base), incl. uncommitted.
 */
export type ReviewMode = 'uncommitted' | 'branch';

export interface LocalPr {
    id: string;
    sourceBranch: string;
    targetBranch: string;
    sourceCommit: string;
    targetCommit: string;
    createdAt: string;
    reviewedFiles?: string[];
    // Working-tree blob hash captured when each file was marked reviewed. A file
    // whose current hash no longer matches is auto-unreviewed (GitHub "Viewed"
    // semantics). Absent entries are backfilled, not evicted, so upgrades don't
    // wipe existing marks.
    reviewedHashes?: { [filePath: string]: string };
    mode?: ReviewMode; // optional for back-compat with pre-mode reviews
    // User-chosen base to diff this branch against (a branch/tag/commit ref). When
    // set, the changed-file list is computed against merge-base(baseRef, HEAD)
    // instead of the auto-detected train base — needed for a branch stacked on top
    // of another branch, where the train base would surface the parent's files too.
    // Absent/empty = auto-detect.
    baseRef?: string;
    // The merge-base the reviewed snapshots were last rebased against. When the live
    // merge-base advances (you merge/rebase the base branch into your feature branch),
    // each snapshot is replayed over the base delta so changes already in the base
    // branch stop showing as "to review". Absent = not yet recorded (first refresh
    // just stores the current base; no retroactive rebase).
    reconciledBase?: string;
}

/**
 * Which git location a change lives in. Only meaningful in 'uncommitted' mode,
 * where it drives the Staged/Unstaged/Untracked grouping. Undefined in 'branch' mode.
 */
export type FileStage = 'staged' | 'unstaged' | 'untracked';

export interface FileChange {
    status: FileChangeStatus;
    filePath: string;
    oldFilePath?: string; // for renames
    stage?: FileStage;
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ReviewThread {
    id: string;
    filePath: string;
    startLine: number;
    endLine: number;
    state: 'resolved' | 'unresolved';
    comments: ReviewComment[];
    // Which side the comment was added on: the working file (after/right side) vs
    // a git ref (before/left side). Drives where it's re-materialized so a comment
    // doesn't get a twin on the opposite diff side. Absent (legacy) ⇒ working tree.
    onWorkingTree?: boolean;
    // The user's triage of a thread they didn't author (team/codex/GitHub). Only
    // such "proposable" threads carry it. 'accepted' = "queue for apply", which is
    // what /apply-review acts on. 'dismissed' = "skip always" — muted: it leaves the
    // triage queue + needs-OK count but stays UNRESOLVED and untouched on GitHub (for
    // a note you keep open for reviewers). Your own comments need no disposition.
    disposition?: 'accepted' | 'dismissed';
    // Set by /apply-review when it made the change for a not-yours thread but left
    // it UNRESOLVED (so you verify + resolve yourself). Prevents re-applying.
    applied?: boolean;
    // Present on threads imported from a GitHub PR — the identity used to upsert on
    // re-sync and to resolve the thread back on GitHub (via the host bridge).
    github?: GithubRef;
    // The code this comment was written against. Captured only when we KNOW it: at
    // local create-time (from the editor), or from a GitHub comment's diff_hunk. We
    // never guess it from the current file. When the current block no longer matches
    // `code`, the thread is "outdated" and we surface `code` so the comment stays
    // linked to what it was actually about. Working-tree threads only.
    anchor?: { code: string };
    // Set when we auto-moved an after-side comment to the before side because its
    // code was DELETED from the working tree (so it shows on the removed/red lines
    // instead of floating on an unrelated working line). Distinguishes it from a
    // comment you deliberately authored on the before pane; cleared if the code
    // comes back. Implies onWorkingTree:false.
    autoBefore?: boolean;
}

export interface GithubRef {
    repo: string;       // "owner/name"
    prNumber: number;
    commentId: number;  // REST databaseId of the head comment — joins to the GraphQL thread
}

export interface ReviewComment {
    id: string;
    body: string;
    author: string;
    timestamp: string;
    // For comments imported from GitHub: the reviewer's avatar URL, downloaded and
    // cached locally so the thread shows their real picture instead of an initial.
    avatarUrl?: string;
    // Which conversation channel this comment belongs to:
    //   'github' — mirrors the PR (loaded, read-only here; resolution syncs).
    //   'local'  — never synced; Claude/you/review-as-* talk here, even layered on
    //              a GitHub thread (a private side-conversation for Claude).
    // Absent (legacy) is inferred at render from the thread + author.
    channel?: 'github' | 'local';
}

export interface CommentsFile {
    version: number;
    sourceBranch: string;
    targetBranch: string;
    sourceCommit: string;
    targetCommit: string;
    threads: ReviewThread[];
    // Your GitHub login, captured by /load-pr-comments. Comments authored under it
    // are treated as yours (so a note you left on your own PR isn't mis-filed as a
    // reviewer's comment awaiting your OK). Absent until a PR has been loaded.
    viewerLogin?: string;
}

export interface LocalPrRegistry {
    version: number;
    reviews: LocalPr[];
    activeReviewId?: string;
    // One-time flag: v0.3.17 backfilled comment anchors by GUESSING from the
    // current file, which produced wrong "original code". v0.3.18 purges those once
    // (anchors are re-derived correctly from create-time / GitHub diff_hunk).
    anchorsReset?: boolean;
}

export interface GitApi {
    repositories: GitRepository[];
    onDidOpenRepository: (cb: (repo: GitRepository) => void) => vscode.Disposable;
}

export interface GitRepository {
    rootUri: vscode.Uri;
    state: {
        HEAD?: {
            name?: string;
            commit?: string;
        };
        onDidChange: vscode.Event<void>;
    };
    getBranches(query: { remote?: boolean }): Promise<GitBranch[]>;
}

export interface GitBranch {
    name?: string;
    commit?: string;
    type?: number;
}

export interface CommitInfo {
    hash: string;
    shortHash: string;
    message: string;
    author: string;
    date: string;
    relativeDate: string;
}
