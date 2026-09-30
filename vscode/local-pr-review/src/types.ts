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

/**
 * Where a thread is in the review loop:
 *  - 'todo'   your move: a new finding, or Claude handled it and it's back to you.
 *  - 'claude' you handed it to Claude; the next /address-review acts on it.
 *  - 'later'  set aside until the next /address-review, which returns it to 'todo'.
 *  - 'closed' finished; nothing more happens with it.
 */
export type ThreadStage = 'todo' | 'claude' | 'later' | 'closed';

/** 'apply' = make the change, then back to you; 'apply-close' = make it and close. */
export type ApplyRequest = 'apply' | 'apply-close';

export interface ReviewThread {
    id: string;
    filePath: string;
    startLine: number;
    endLine: number;
    // Where the thread is in the review loop. Threads saved before stages existed
    // carry only `state` instead.
    stage?: ThreadStage;
    state?: 'resolved' | 'unresolved';
    // For a 'claude' thread, whether Claude should also make the change the thread
    // asks for, and whether the thread then closes or comes back to you.
    request?: ApplyRequest;
    comments: ReviewComment[];
    // Which side the comment was added on: the working file (after/right side) vs
    // a git ref (before/left side). Drives where it's re-materialized so a comment
    // doesn't get a twin on the opposite diff side. Absent (legacy) ⇒ working tree.
    onWorkingTree?: boolean;
    // Whether Claude changed code the last time it handled the thread.
    applied?: boolean;
    // The code this comment was written against. Captured only when we KNOW it: when
    // the comment is created. We never guess it later from the current file. When
    // the current block no longer matches `code`, the thread is "outdated" and we
    // surface `code` so the comment stays linked to what it was actually about.
    // `movedTo` is the code the thread sits on instead, set when Claude's edit
    // replaced `code` (a rename, a move, a rewrite): placement searches for it, while
    // `code` keeps what the comment was written against.
    // Working-tree threads only.
    anchor?: { code: string; movedTo?: string };
    // Set when we auto-moved an after-side comment to the before side because its
    // code was DELETED from the working tree (so it shows on the removed/red lines
    // instead of floating on an unrelated working line). Distinguishes it from a
    // comment you deliberately authored on the before pane; cleared if the code
    // comes back. Implies onWorkingTree:false.
    autoBefore?: boolean;
}

export interface ReviewComment {
    id: string;
    body: string;
    author: string;
    timestamp: string;
}

export interface CommentsFile {
    version: number;
    sourceBranch: string;
    targetBranch: string;
    sourceCommit: string;
    targetCommit: string;
    threads: ReviewThread[];
}

export interface LocalPrRegistry {
    version: number;
    reviews: LocalPr[];
    activeReviewId?: string;
    // One-time flag: v0.3.17 backfilled comment anchors by GUESSING from the
    // current file, which produced wrong "original code". v0.3.18 purges those once
    // (anchors are re-derived correctly from create-time).
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
