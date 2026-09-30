import * as vscode from 'vscode';
import { StorageService } from '../storage/storageService';
import { ApplyRequest, ReviewThread, ReviewComment, ThreadStage } from '../types';
import { GitService } from '../git/gitService';
import { getAvatarUri } from './avatars';
import { isOwnAuthor } from '../identity';
import { moveThread, stageOf, stageTag, STAGE_LABEL } from '../stage';
import * as os from 'os';

interface ThreadData {
    threadId: string;
    filePath: string;
}

export class ReviewCommentController {
    private controller: vscode.CommentController;
    private threads = new Map<string, vscode.CommentThread>();
    // Thread ids whose anchored code is GONE from the working tree (edited / deleted /
    // applied away). They get NO working-file (file://) instance — their inline home is
    // the diff's before pane, placed by content search. Recomputed by recomputeOutdated;
    // read by refreshThreadComments so a background refresh won't re-float them.
    private detachedIds = new Set<string>();
    private gitService: GitService | undefined;
    private reviewableFiles = new Set<string>();
    private readonly ownUser = os.userInfo().username;

    constructor(
        private storageService: StorageService,
        private avatarDir: vscode.Uri
    ) {
        this.controller = vscode.comments.createCommentController(
            'localPrReview',
            'Local Review'
        );

        // GitHub-like empty-box prompt.
        this.controller.options = {
            prompt: 'Leave a comment',
            placeHolder: 'Leave a comment',
        };

        const self = this;
        this.controller.commentingRangeProvider = {
            provideCommentingRanges(document: vscode.TextDocument): vscode.Range[] {
                if (document.uri.scheme === 'git-local-review') {
                    // Use a large range to avoid race with async content loading
                    const lastLine = Math.max(document.lineCount - 1, 100000);
                    return [new vscode.Range(0, 0, lastLine, 0)];
                }
                // The before/index pane of VS Code's NATIVE uncommitted-unstaged diff
                // (git.openChange) is a `git:` document. Claim it (for reviewable
                // files) so a comment about deleted code can sit on the red removed
                // lines there — without giving up the native diff's stage arrows.
                if (document.uri.scheme === 'git') {
                    const relativePath = gitUriToRelPath(document.uri);
                    if (relativePath && (self.reviewableFiles.has(relativePath) || self.hasThreadsForFile(relativePath))) {
                        const lastLine = Math.max(document.lineCount - 1, 100000);
                        return [new vscode.Range(0, 0, lastLine, 0)];
                    }
                }
                // Allow comments on working-tree files that are part of the active review
                if (document.uri.scheme === 'file') {
                    const relativePath = vscode.workspace.asRelativePath(document.uri, false);
                    // Check both the explicit set and whether this file has existing threads
                    if (self.reviewableFiles.has(relativePath) || self.hasThreadsForFile(relativePath)) {
                        const lastLine = Math.max(document.lineCount - 1, 0);
                        return [new vscode.Range(0, 0, lastLine, 0)];
                    }
                }
                return [];
            },
        };
    }

    /**
     * Set the list of file paths (workspace-relative) that are part of the active review.
     * This enables commenting on working-tree files shown in diffs.
     */
    setReviewableFiles(filePaths: string[]): void {
        this.reviewableFiles.clear();
        for (const p of filePaths) {
            this.reviewableFiles.add(p);
        }
    }

    /**
     * Check if any loaded threads reference this file path.
     */
    private hasThreadsForFile(relativePath: string): boolean {
        for (const thread of this.threads.values()) {
            const data = (thread as any).__threadData as ThreadData | undefined;
            if (data && data.filePath === relativePath) {
                return true;
            }
        }
        return false;
    }

    /**
     * Place a file's comments across BOTH panes of an open diff, content-addressed:
     * each comment is rendered wherever its anchor code actually appears, never at a
     * stored line number (which is a working-tree line and doesn't map onto a snapshot
     * or base pane — that mismatch is what threw comments "way off"). The newer (right)
     * pane wins, so a comment whose code is unchanged shows once on the current code;
     * one whose code was applied/changed away from the right shows on the left, on its
     * original code. A comment whose anchor is in NEITHER pane isn't floated here — it
     * stays in the navigator (with its snapshot), which can route you to it.
     *
     * The working file:// instances (the To Review diff's right pane + the plain
     * editor) are owned by recomputeOutdated, which keeps them content-positioned; we
     * just treat an existing one as "already placed on the right" so we don't also
     * render it on the left.
     */
    async placeThreadsInDiff(left: vscode.Uri, right: vscode.Uri, filePath: string): Promise<void> {
        const comments = this.storageService.loadComments();
        if (!comments) { return; }

        const placed = new Set<string>();
        if (right.scheme === 'file') {
            for (const t of comments.threads) {
                if (t.filePath === filePath && this.threads.has(t.id)) { placed.add(t.id); }
            }
        } else {
            await this.placeThreadsOnPane(right, filePath, placed);
        }
        await this.placeThreadsOnPane(left, filePath, placed);
    }

    /**
     * Render every not-yet-placed comment for `filePath` whose anchor code is found in
     * this (non-working) diff pane, positioned ON that code. Skips a comment whose
     * anchor isn't in the pane (no stored-line fallback — a guessed line is the "way
     * off" we're fixing) and any with no anchor (nothing to search by).
     */
    private async placeThreadsOnPane(uri: vscode.Uri, filePath: string, placed: Set<string>): Promise<void> {
        const comments = this.storageService.loadComments();
        if (!comments) { return; }
        let doc: vscode.TextDocument;
        try {
            doc = await vscode.workspace.openTextDocument(uri);
        } catch {
            return;
        }
        const text = doc.getText();

        for (const t of comments.threads) {
            if (t.filePath !== filePath || placed.has(t.id) || !t.anchor) { continue; }
            const code = placementCode(t.anchor);
            const loc = findBlockLine(text, code);
            if (loc < 0) { continue; }
            const span = normalizeCode(code).split('\n').length;
            const range = new vscode.Range(loc, 0, loc + span - 1, 0);
            const dKey = `${t.id}::${uri.toString()}`;
            const existing = this.threads.get(dKey);
            if (existing) {
                if (!existing.range?.isEqual(range)) { existing.range = range; }
            } else {
                this.createVscodeThread(uri, t, dKey, range);
            }
            placed.add(t.id);
        }
    }

    /** Drop a thread's working-file (file://) instance, if it has one. */
    private disposeWorkingInstance(threadId: string): void {
        const inst = this.threads.get(threadId);
        if (inst && inst.uri.scheme === 'file') {
            inst.dispose();
            this.threads.delete(threadId);
        }
    }

    /** Ensure a thread's working-file instance exists AT `range` (create or reposition). */
    private placeWorkingInstance(thread: ReviewThread, fileUri: vscode.Uri, range: vscode.Range): void {
        const existing = this.threads.get(thread.id);
        if (existing && existing.uri.scheme === 'file') {
            if (!existing.range?.isEqual(range)) { existing.range = range; }
        } else {
            this.createVscodeThread(fileUri, thread, thread.id, range);
        }
    }

    /**
     * Scroll a visible before pane (git: / git-local-review) to where `anchorCode`
     * appears, and place the cursor there. Used to jump to a before-side comment from
     * the navigator (its stored line is a working-tree line, so we locate by content).
     * Returns false if no visible before pane contains the code yet.
     */
    async revealBeforeAnchor(anchorCode: string): Promise<boolean> {
        for (const ed of vscode.window.visibleTextEditors) {
            const scheme = ed.document.uri.scheme;
            if (scheme !== 'git' && scheme !== 'git-local-review') { continue; }
            const line = findBlockLine(ed.document.getText(), anchorCode);
            if (line < 0) { continue; }
            const pos = new vscode.Position(line, 0);
            ed.selection = new vscode.Selection(pos, pos);
            ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            return true;
        }
        return false;
    }

    /**
     * Refresh the comments/state of every existing thread instance from storage,
     * in place (no dispose/recreate). Used when the store changes externally.
     * Disposes instances whose thread was deleted, and
     * creates file:// instances for threads that have none yet.
     */
    /** Is this author you? */
    private isOwn(author: string): boolean {
        return isOwnAuthor(author, this.ownUser);
    }

    refreshThreadComments(): void {
        const comments = this.storageService.loadComments();
        const byId = new Map((comments?.threads ?? []).map(t => [t.id, t]));

        for (const [key, thread] of [...this.threads]) {
            const data = (thread as any).__threadData as ThreadData | undefined;
            const stored = data ? byId.get(data.threadId) : undefined;
            if (!stored) {
                thread.dispose();
                this.threads.delete(key);
                continue;
            }
            // A thread that moved to the before side must drop its working-file
            // (file://) instance — that's the copy that floats a deleted comment on an
            // unrelated working line. Its before-pane instance is created on diff open.
            if (stored.onWorkingTree === false && thread.uri.scheme === 'file') {
                thread.dispose();
                this.threads.delete(key);
                continue;
            }
            // Skip threads whose visible content is unchanged: reassigning
            // thread.comments re-renders and re-expands the thread, which resets an
            // in-progress reply and can throw focus to another thread when a
            // background refresh (save / git-state change) fires mid-typing.
            const sig = this.renderSignature(stored);
            if ((thread as any).__renderSig === sig) { continue; }
            (thread as any).__renderSig = sig;
            thread.comments = this.renderComments(stored);
            this.styleThread(thread, stored);
        }

        const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        for (const t of comments?.threads ?? []) {
            // Skip detached threads (anchor code gone from the working tree): they have
            // no working-file home, so re-creating one here would float them on an
            // unrelated line — exactly what recomputeOutdated just disposed.
            if (t.onWorkingTree !== false && !this.detachedIds.has(t.id)
                && !this.threads.has(t.id) && workspaceUri) {
                this.createVscodeThread(vscode.Uri.joinPath(workspaceUri, t.filePath), t, t.id);
            }
        }
    }

    /**
     * Reconcile every comment against the working tree: compute which are "outdated"
     * (their anchor code is gone — edited/deleted/applied away — or they're `applied`),
     * which are "detached" (no longer in the working tree at all), and content-position
     * each thread's working-file instance ON its anchor code so an in-place edit / line
     * shift doesn't leave it floating at a stale line. A detached thread's working
     * instance is dropped — its inline home is the diff's before pane (placed on open by
     * placeThreadsInDiff). We never synthesize an anchor from the current file (guessing
     * the original from already-changed code was the old "wrong original code" bug), so a
     * thread with no anchor is left where it is. Runs on every load/refresh.
     */
    async recomputeOutdated(): Promise<void> {
        const comments = this.storageService.loadComments();
        const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!comments || !workspaceUri) {
            this.storageService.outdatedThreadIds = new Set();
            this.detachedIds = new Set();
            return;
        }

        const byFile = new Map<string, ReviewThread[]>();
        for (const t of comments.threads) {
            if (!byFile.has(t.filePath)) { byFile.set(t.filePath, []); }
            byFile.get(t.filePath)!.push(t);
        }

        const outdated = new Set<string>();
        const detached = new Set<string>();
        let migrated = false;
        for (const [filePath, threads] of byFile) {
            const fileUri = vscode.Uri.joinPath(workspaceUri, filePath);
            let doc: vscode.TextDocument | undefined;
            try {
                doc = await vscode.workspace.openTextDocument(fileUri);
            } catch { /* file gone / unreadable */ }
            const text = doc ? doc.getText() : undefined;
            for (const t of threads) {
                if (t.applied) { outdated.add(t.id); }
                if (!t.anchor) { continue; }
                // A genuine native before-comment (authored on a before pane) stays
                // there — it's not tracked against the working tree.
                if (t.onWorkingTree === false && !t.autoBefore) { continue; }
                // Migrate a thread relocated by the OLD before-side logic back to plain
                // content handling (the flag is no longer how placement is decided).
                if (t.autoBefore || t.onWorkingTree === false) {
                    delete t.autoBefore;
                    t.onWorkingTree = true;
                    migrated = true;
                }
                const code = placementCode(t.anchor);
                const span = normalizeCode(code).split('\n').length;
                const loc = text !== undefined ? findBlockLine(text, code) : -1;
                if (loc < 0 && text !== undefined) {
                    // Exact anchor gone (its code was edited — often to ADDRESS the
                    // comment, which is exactly when we must not lose it). Fall back to
                    // the closest matching line so it stays visible on the working tree,
                    // flagged outdated. Fuzzy is working-tree-only; if even that misses,
                    // detach (navigator-only) as before.
                    const fuzzy = findBlockLineFuzzy(text, code);
                    if (fuzzy >= 0) {
                        outdated.add(t.id);
                        this.placeWorkingInstance(t, fileUri, new vscode.Range(fuzzy, 0, fuzzy + span - 1, 0));
                        continue;
                    }
                }
                if (loc < 0) {
                    // Original code gone from the working tree → outdated + detached;
                    // drop its working instance so it doesn't float on an unrelated line.
                    outdated.add(t.id);
                    detached.add(t.id);
                    this.disposeWorkingInstance(t.id);
                } else {
                    this.placeWorkingInstance(t, fileUri, new vscode.Range(loc, 0, loc + span - 1, 0));
                }
            }
        }

        this.storageService.outdatedThreadIds = outdated;
        this.detachedIds = detached;
        if (migrated) { this.storageService.saveComments(comments); }
        this.refreshThreadComments();
    }

    /**
     * Build a thread's rendered comments, prepending the synthetic "when commented"
     * snapshot bubble when the thread is outdated (so the original code it was
     * written against stays visible next to the discussion).
     */
    private renderComments(stored: ReviewThread): vscode.Comment[] {
        const out: vscode.Comment[] = [];
        if (this.storageService.outdatedThreadIds.has(stored.id) && stored.anchor) {
            out.push(this.makeSnapshotComment(stored));
        }
        out.push(...stored.comments.map(c => this.toVscodeComment(c)));
        return out;
    }

    /**
     * A compact fingerprint of everything renderComments + styleThread depend on, so
     * refreshThreadComments can skip a thread whose visible content is unchanged.
     * Skipping the no-op reassignment of `thread.comments` is what stops a background
     * refresh from resetting the reply widget / stealing focus while you type.
     */
    private renderSignature(stored: ReviewThread): string {
        const outdated = this.storageService.outdatedThreadIds.has(stored.id);
        return JSON.stringify({
            sg: stageOf(stored),
            rq: stored.request,
            ap: stored.applied,
            ow: stored.onWorkingTree,
            od: outdated,
            an: outdated ? [stored.anchor?.code, stored.startLine, stored.endLine] : null,
            cs: stored.comments.map(c => [c.id, c.body, c.author, c.timestamp]),
        });
    }

    /**
     * A quiet, non-persisted "📜 Local Review · when commented" bubble holding the
     * code the comment was written against. Not editable/deletable (no `canEdit`
     * contextValue, no `__id`), so it stays clear of the edit/delete paths.
     */
    private makeSnapshotComment(stored: ReviewThread): vscode.Comment {
        const code = stored.anchor?.code ?? '';
        const s = stored.startLine + 1;
        const e = stored.endLine + 1;
        // A moved thread's lines are those of the code it moved to, not of this code.
        const where = stored.anchor?.movedTo !== undefined ? '' : s === e ? ` · line ${s}` : ` · lines ${s}–${e}`;
        const body = new vscode.MarkdownString();
        body.appendMarkdown(`$(history) *Code at the time of this comment${where}*\n\n`);
        body.appendCodeblock(code, langFromPath(stored.filePath));
        body.supportThemeIcons = true;
        return {
            body,
            author: {
                name: 'Local Review',
                iconPath: getAvatarUri(this.avatarDir, 'Local Review'),
            },
            mode: vscode.CommentMode.Preview,
            contextValue: 'snapshot',
            timestamp: new Date(stored.comments[0]?.timestamp ?? new Date().toISOString()),
            label: 'when commented',
        };
    }

    /** Text of a file's startLine..endLine block (0-based, clamped to the doc). */
    private rangeText(doc: vscode.TextDocument, startLine: number, endLine: number): string {
        const last = Math.max(0, doc.lineCount - 1);
        const s = Math.max(0, Math.min(startLine, last));
        const e = Math.max(s, Math.min(endLine, last));
        return doc.getText(new vscode.Range(s, 0, e, doc.lineAt(e).text.length));
    }

    /**
     * Load all threads for the active review across all files
     */
    async loadAllThreads(gitService?: GitService, sourceBranch?: string, targetBranch?: string): Promise<void> {
        this.clearAllThreads();

        if (gitService) {
            this.gitService = gitService;
        }

        const comments = this.storageService.loadComments();
        if (!comments || comments.threads.length === 0) { return; }

        const gs = this.gitService;
        if (!gs || !sourceBranch || !targetBranch) {
            // Fallback: try to derive branches from stored comments
            const src = sourceBranch || comments.sourceBranch;
            const tgt = targetBranch || comments.targetBranch;
            if (!src || !tgt) { return; }
            await this.loadAllThreadsForBranches(comments.threads, src, tgt, gs);
            return;
        }

        await this.loadAllThreadsForBranches(comments.threads, sourceBranch, targetBranch, gs);
    }

    private async loadAllThreadsForBranches(
        threads: ReviewThread[],
        sourceBranch: string,
        targetBranch: string,
        gitService?: GitService
    ): Promise<void> {
        // Group threads by file
        const fileThreads = new Map<string, ReviewThread[]>();
        for (const thread of threads) {
            if (!fileThreads.has(thread.filePath)) {
                fileThreads.set(thread.filePath, []);
            }
            fileThreads.get(thread.filePath)!.push(thread);
        }

        const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspaceUri) { return; }

        // Workspace file:// instances (Comments panel + working/right pane) for
        // after-side threads. Before-side threads materialize on the diff's before
        // pane when it opens; here they'd only float on the working file.
        for (const [filePath, fileSpecificThreads] of fileThreads) {
            const fileUri = vscode.Uri.joinPath(workspaceUri, filePath);

            for (const thread of fileSpecificThreads) {
                if (thread.onWorkingTree !== false && !this.threads.has(thread.id)) {
                    this.createVscodeThread(fileUri, thread, thread.id);
                }
            }
        }
    }

    createThread(
        uri: vscode.Uri,
        range: vscode.Range,
        text: string,
        filePath: string,
        existingThread?: vscode.CommentThread
    ): void {
        const author = os.userInfo().username;
        const savedThread = this.storageService.addThread(
            filePath,
            range.start.line,
            range.end.line,
            text,
            author,
            uri.scheme === 'file'
        );

        // Snapshot the commented rows now, while they're still the code you're
        // commenting on, so a later edit flips the thread to "outdated" against this.
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        if (doc) {
            const code = this.rangeText(doc, range.start.line, range.end.line);
            this.storageService.setAnchor(savedThread.id, { code });
            savedThread.anchor = { code };
        }

        if (uri.scheme !== 'file') {
            // Repurpose the existing VS Code thread for the diff view (avoids race on dispose)
            if (existingThread) {
                this.populateThread(existingThread, savedThread, `${savedThread.id}::${uri.toString()}`);
            } else {
                this.createVscodeThread(uri, savedThread, `${savedThread.id}::${uri.toString()}`);
            }
            // Also create a file:// thread so it appears in the Comments panel
            const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (workspaceUri) {
                const fileUri = vscode.Uri.joinPath(workspaceUri, filePath);
                this.createVscodeThread(fileUri, savedThread, savedThread.id);
            }
        } else {
            // For file:// URIs, repurpose the existing thread directly
            if (existingThread) {
                this.populateThread(existingThread, savedThread, savedThread.id);
            } else {
                this.createVscodeThread(uri, savedThread, savedThread.id);
            }
        }
    }

    private populateThread(thread: vscode.CommentThread, savedThread: ReviewThread, key: string): void {
        thread.comments = this.renderComments(savedThread);
        thread.canReply = true;
        this.styleThread(thread, savedThread);
        (thread as any).__renderSig = this.renderSignature(savedThread);

        (thread as any).__threadData = {
            threadId: savedThread.id,
            filePath: savedThread.filePath,
        } satisfies ThreadData;

        this.threads.set(key, thread);
    }

    /**
     * Set a thread's visual/contextual state (collapse, label, reply box, and the
     * `contextValue` that gates the inline actions) from its stored form. The
     * contextValue is the stage, plus `.apply` / `.apply-close` on a 'claude' thread
     * carrying that request; the menus match it by regex.
     * Does NOT touch `comments` — callers reassign that only when it changed, to
     * avoid the re-render that would re-expand a collapsed thread.
     */
    private styleThread(thread: vscode.CommentThread, stored: ReviewThread): void {
        const stage = stageOf(stored);
        const closed = stage === 'closed';
        const outdated = this.storageService.outdatedThreadIds.has(stored.id);

        // Only assign when the value actually changes. Re-asserting collapsibleState
        // re-expands the thread and can yank editor focus onto it — bad if it fires
        // (via a background refresh) while you're typing in another thread. The guard
        // also means we stop fighting a thread the user manually collapsed.
        const desiredState = closed
            ? vscode.CommentThreadState.Resolved
            : vscode.CommentThreadState.Unresolved;
        if (thread.state !== desiredState) { thread.state = desiredState; }
        // Only To do threads open in the editor; the rest fold to their gutter icon,
        // so what's open is what needs you.
        const desiredCollapse = stage === 'todo'
            ? vscode.CommentThreadCollapsibleState.Expanded
            : vscode.CommentThreadCollapsibleState.Collapsed;
        if (thread.collapsibleState !== desiredCollapse) { thread.collapsibleState = desiredCollapse; }
        // Nothing reads a closed thread again, so a reply there would go unanswered.
        if (thread.canReply !== !closed) { thread.canReply = !closed; }
        thread.label = [STAGE_LABEL[stage], stageTag(stored), outdated ? 'outdated' : '']
            .filter(Boolean)
            .join(' · ');

        // NOTE: "outdated" is surfaced via the thread LABEL + the navigator tag, NOT
        // a contextValue token. The inline-action `when` clauses anchor on the exact
        // token set (e.g. Later = `todo`), so an extra `.outdated` token would hide
        // those buttons on outdated threads.
        thread.contextValue = stage === 'claude' && stored.request
            ? `${stage}.${stored.request}`
            : stage;
    }

    /** Re-style every live instance of a logical thread from its current stored form. */
    private restyleAll(threadId: string): void {
        const comments = this.storageService.loadComments();
        const stored = comments?.threads.find(t => t.id === threadId);
        if (!stored) { return; }
        for (const t of this.threads.values()) {
            const d = (t as any).__threadData as ThreadData | undefined;
            if (d?.threadId === threadId) { this.styleThread(t, stored); }
        }
    }

    private createVscodeThread(uri: vscode.Uri, savedThread: ReviewThread, key?: string, rangeOverride?: vscode.Range): void {
        const threadKey = key || savedThread.id;
        const range = rangeOverride ?? new vscode.Range(savedThread.startLine, 0, savedThread.endLine, 0);
        const thread = this.controller.createCommentThread(uri, range, []);

        thread.comments = this.renderComments(savedThread);
        thread.canReply = true;
        this.styleThread(thread, savedThread);
        (thread as any).__renderSig = this.renderSignature(savedThread);

        // Store thread data for later retrieval
        (thread as any).__threadData = {
            threadId: savedThread.id,
            filePath: savedThread.filePath,
        } satisfies ThreadData;

        this.threads.set(threadKey, thread);
    }

    private toVscodeComment(comment: ReviewComment): vscode.Comment {
        const displayName = this.isOwn(comment.author) ? 'You' : comment.author;
        const vscodeComment: vscode.Comment = {
            body: new vscode.MarkdownString(comment.body),
            author: {
                name: displayName,
                iconPath: getAvatarUri(this.avatarDir, displayName),
            },
            mode: vscode.CommentMode.Preview,
            // Only your own comments can be edited or deleted: a reviewer's finding
            // must stay as posted, since a re-run of the review recognizes it by its
            // text and a deleted one would be posted again.
            contextValue: this.isOwn(comment.author) ? 'canEdit' : undefined,
            timestamp: new Date(comment.timestamp),
            label: this.authorLabel(comment.author),
        };
        // Keep the storage id on the rendered comment so edits map back.
        (vscodeComment as any).__id = comment.id;
        return vscodeComment;
    }

    /** Put a comment into the inline edit textarea (and re-render so it shows). */
    startEdit(comment: vscode.Comment): void {
        const thread = this.findThreadForComment(comment);
        if (!thread) { return; }
        (comment as any).mode = vscode.CommentMode.Editing;
        thread.comments = [...thread.comments];
    }

    /** Persist an edited comment body and return it to preview mode. */
    saveEdit(comment: vscode.Comment): void {
        const thread = this.findThreadForComment(comment);
        if (!thread) { return; }
        const data = (thread as any).__threadData as ThreadData | undefined;
        const storageId = (comment as any).__id as string | undefined;
        const newBody = typeof comment.body === 'string'
            ? comment.body
            : comment.body.value;
        if (data && storageId) {
            this.storageService.editComment(data.threadId, storageId, newBody);
        }
        (comment as any).body = new vscode.MarkdownString(newBody);
        (comment as any).mode = vscode.CommentMode.Preview;
        thread.comments = [...thread.comments];
    }

    /** Discard unsaved edits, restore the stored body, return to preview. */
    cancelEdit(comment: vscode.Comment): void {
        const thread = this.findThreadForComment(comment);
        if (!thread) { return; }
        const data = (thread as any).__threadData as ThreadData | undefined;
        const storageId = (comment as any).__id as string | undefined;
        if (data && storageId) {
            const stored = this.storageService.loadComments()
                ?.threads.find(t => t.id === data.threadId)
                ?.comments.find(c => c.id === storageId);
            if (stored) {
                (comment as any).body = new vscode.MarkdownString(stored.body);
            }
        }
        (comment as any).mode = vscode.CommentMode.Preview;
        thread.comments = [...thread.comments];
    }

    /** GitHub-style role badge shown next to the author name. */
    private authorLabel(author: string): string | undefined {
        if (author === 'team' || author === 'codex' || author === 'learnings' || author === 'claude') {
            return 'AI';
        }
        // Your own name renders as "you" (see toVscodeComment), so no 'you' badge.
        return undefined;
    }

    /** The stored thread id behind a live comment thread, if it has one. */
    threadIdOf(thread: vscode.CommentThread): string | undefined {
        return ((thread as any).__threadData as ThreadData | undefined)?.threadId;
    }

    /** Move a thread to `stage`, with an apply request when handing it to Claude. */
    moveThreadById(threadId: string, stage: ThreadStage, request?: ApplyRequest): void {
        this.storageService.updateThread(threadId, t => moveThread(t, stage, request));
        this.refreshThreadComments();
    }

    /**
     * Post a reply authored by you and hand the thread to Claude, keeping any apply
     * request it already has so the reply refines it. Used where there is no live
     * reply box (the navigator and the step-through picker).
     */
    replyToThreadById(threadId: string, text: string): void {
        this.storageService.addReplyToThread(threadId, text, this.ownUser);
        this.storageService.updateThread(threadId, t => moveThread(t, 'claude', t.request));
        this.refreshThreadComments();
    }

    /** Post a reply from the thread's reply box and hand the thread to Claude. */
    addReply(thread: vscode.CommentThread, text: string): void {
        const data = (thread as any).__threadData as ThreadData | undefined;
        if (!data) { return; }

        const author = os.userInfo().username;
        const comment = this.storageService.addReplyToThread(data.threadId, text, author);
        if (comment) {
            this.storageService.updateThread(data.threadId, t => moveThread(t, 'claude', t.request));
            thread.comments = [...thread.comments, this.toVscodeComment(comment)];
            this.restyleAll(data.threadId);
        }
    }

    deleteComment(thread: vscode.CommentThread, comment: vscode.Comment): void {
        const data = (thread as any).__threadData as ThreadData | undefined;
        if (!data) { return; }

        const storedThread = this.storageService.loadComments()
            ?.threads.find(t => t.id === data.threadId);
        if (!storedThread) { return; }

        // Match by the stable storage id stashed on the rendered comment — NOT the
        // display name: author.name is now "You"/role text, not the stored author,
        // so a name match silently failed for your own comments. Fall back to
        // timestamp for any legacy render that lacks __id.
        const storageId = (comment as any).__id as string | undefined;
        const ts = comment.timestamp?.getTime();
        const target = storageId
            ? storedThread.comments.find(c => c.id === storageId)
            : storedThread.comments.find(c => new Date(c.timestamp).getTime() === ts);
        if (!target) { return; }

        this.storageService.deleteComment(data.threadId, target.id);
        // Re-sync every live instance: drops the comment, or disposes the thread if
        // it became empty (storageService removes empty threads). Handles all the
        // diff-side + Comments-panel copies, not just the clicked one.
        this.refreshThreadComments();
    }

    findThreadForComment(comment: vscode.Comment): vscode.CommentThread | undefined {
        for (const thread of this.threads.values()) {
            if (thread.comments.includes(comment)) {
                return thread;
            }
        }
        return undefined;
    }

    private clearAllThreads(): void {
        for (const thread of this.threads.values()) {
            thread.dispose();
        }
        this.threads.clear();
    }

    dispose(): void {
        this.clearAllThreads();
        this.controller.dispose();
    }
}

/**
 * Workspace-relative path for a VS Code `git:` document URI. Its `.path` is the
 * file's absolute fs path (the `?{…ref…}` query just selects index/HEAD), so we
 * derive the relative path from that rather than parsing the query JSON.
 */
function gitUriToRelPath(uri: vscode.Uri): string | undefined {
    try {
        return vscode.workspace.asRelativePath(vscode.Uri.file(uri.path), false);
    } catch {
        return undefined;
    }
}

function normalizeCode(s: string): string {
    const lines = s.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''));
    while (lines.length && lines[0] === '') { lines.shift(); }
    while (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
    return lines.join('\n');
}

/** The code a thread sits on: where Claude moved it, else the code it was written against. */
function placementCode(anchor: { code: string; movedTo?: string }): string {
    return anchor.movedTo ?? anchor.code;
}

/**
 * 0-based line where `block` first appears in `text` (trailing-whitespace tolerant),
 * or -1 if not found. Used to position a before-side comment by its anchor code.
 */
function findBlockLine(text: string, block: string): number {
    const blockLines = normalizeCode(block).split('\n');
    if (blockLines.length === 0 || blockLines[0] === '') { return -1; }
    const docLines = text.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''));
    for (let i = 0; i + blockLines.length <= docLines.length; i++) {
        let ok = true;
        for (let j = 0; j < blockLines.length; j++) {
            if (docLines[i + j] !== blockLines[j]) { ok = false; break; }
        }
        if (ok) { return i; }
    }
    return -1;
}

/** Token (word) Jaccard similarity of two lines, in [0, 1]. */
function lineSimilarity(a: string, b: string): number {
    const toks = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9_]+/i).filter(Boolean));
    const ta = toks(a), tb = toks(b);
    if (ta.size === 0 || tb.size === 0) { return 0; }
    let inter = 0;
    for (const x of ta) { if (tb.has(x)) { inter++; } }
    return inter / (ta.size + tb.size - inter);
}

/**
 * Fallback for findBlockLine when the anchor code was EDITED in place, so exact match
 * fails: the 0-based line most similar (token Jaccard) to the anchor's most distinctive
 * line, if it clears `threshold`; else -1. Keyed on a single line so an inserted/removed
 * line inside the block doesn't break alignment, and skips a too-short key (a `}` or
 * `return;` would false-match). Used ONLY against the working tree — placing a drifted
 * comment near its now-edited code (flagged outdated) beats hiding it, whereas fuzzy-
 * matching a base/snapshot pane would land it on genuinely unrelated code.
 */
function findBlockLineFuzzy(text: string, block: string, threshold = 0.5): number {
    const norm = normalizeCode(block).split('\n');
    const key = norm.reduce((a, b) => (b.length > a.length ? b : a), '');
    if (key.trim().length < 12) { return -1; }
    const keyIdx = norm.indexOf(key);
    const docLines = text.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''));
    let best = -1, bestScore = threshold;
    for (let i = 0; i < docLines.length; i++) {
        const s = lineSimilarity(docLines[i], key);
        if (s > bestScore) { bestScore = s; best = i; }
    }
    return best < 0 ? -1 : Math.max(0, best - keyIdx);
}

/** Markdown code-fence language hint for a file path, for the snapshot bubble. */
function langFromPath(filePath: string): string {
    const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
    const byExt: Record<string, string> = {
        ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
        nr: 'rust', rs: 'rust', sol: 'solidity', py: 'python', go: 'go',
        json: 'json', md: 'markdown', sh: 'shellscript', yml: 'yaml', yaml: 'yaml', toml: 'toml',
    };
    return byExt[ext] ?? '';
}
