import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CommentsFile, ReviewThread, ReviewComment } from '../types';
import { LocalPrManager } from '../services/localPrManager';

export class StorageService {
    /** Timestamp of the extension's most recent write, so the file watcher can
     *  tell our own saves apart from external edits (e.g. /apply-review). */
    lastWriteAt = 0;

    /** Thread ids whose code has drifted from their anchor snapshot (or were
     *  applied). Transient — recomputed by the controller from the working files,
     *  never persisted. Read by styling + the navigator to flag "outdated". */
    outdatedThreadIds = new Set<string>();

    constructor(private localPrManager: LocalPrManager) {}

    loadComments(): CommentsFile | undefined {
        const review = this.localPrManager.getActiveReview();
        if (!review) { return undefined; }

        const filePath = this.localPrManager.getCommentsFilePath(review);
        try {
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf-8');
                return JSON.parse(data);
            }
        } catch {
            // ignore parse errors
        }

        return {
            version: 1,
            sourceBranch: review.sourceBranch,
            targetBranch: review.targetBranch,
            sourceCommit: review.sourceCommit,
            targetCommit: review.targetCommit,
            threads: [],
        };
    }

    saveComments(comments: CommentsFile): void {
        const review = this.localPrManager.getActiveReview();
        if (!review) { return; }

        const filePath = this.localPrManager.getCommentsFilePath(review);

        this.lastWriteAt = Date.now();

        // Always write, even when empty. We used to delete the file+dir on zero
        // threads, but that turned a transient "active review flipped to an empty
        // one" (e.g. a review keyed on a branch that momentarily resolved to HEAD)
        // into permanent data loss: the orphaned review's comments dir got removed
        // out from under it. An empty {threads:[]} file is harmless; deletion isn't.
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(comments, null, 2), 'utf-8');
    }

    addThread(filePath: string, startLine: number, endLine: number, body: string, author: string, onWorkingTree: boolean = true): ReviewThread {
        const comments = this.loadComments();
        if (!comments) {
            throw new Error('No active review');
        }

        const thread: ReviewThread = {
            id: crypto.randomUUID(),
            filePath,
            startLine,
            endLine,
            state: 'unresolved',
            comments: [{
                id: crypto.randomUUID(),
                body,
                author,
                timestamp: new Date().toISOString(),
                channel: 'local',
            }],
            onWorkingTree,
        };

        comments.threads.push(thread);
        this.saveComments(comments);
        return thread;
    }

    addReplyToThread(threadId: string, body: string, author: string): ReviewComment | undefined {
        const comments = this.loadComments();
        if (!comments) { return undefined; }

        const thread = comments.threads.find(t => t.id === threadId);
        if (!thread) { return undefined; }

        const comment: ReviewComment = {
            id: crypto.randomUUID(),
            body,
            author,
            timestamp: new Date().toISOString(),
            channel: 'local',
        };

        thread.comments.push(comment);
        this.saveComments(comments);
        return comment;
    }

    resolveThread(threadId: string): void {
        const comments = this.loadComments();
        if (!comments) { return; }

        const thread = comments.threads.find(t => t.id === threadId);
        if (thread) {
            thread.state = 'resolved';
            this.saveComments(comments);
        }
    }

    unresolveThread(threadId: string): void {
        const comments = this.loadComments();
        if (!comments) { return; }

        const thread = comments.threads.find(t => t.id === threadId);
        if (thread) {
            thread.state = 'unresolved';
            this.saveComments(comments);
        }
    }

    /** Persist a thread's anchor snapshot (the code it was written against). */
    setAnchor(threadId: string, anchor: { code: string }): void {
        const comments = this.loadComments();
        if (!comments) { return; }

        const thread = comments.threads.find(t => t.id === threadId);
        if (thread) {
            thread.anchor = anchor;
            this.saveComments(comments);
        }
    }

    /** Queue a proposable (not-your-own) thread so /apply-review acts on it. */
    setDisposition(threadId: string, disposition: 'accepted' | 'dismissed' | undefined): void {
        const comments = this.loadComments();
        if (!comments) { return; }

        const thread = comments.threads.find(t => t.id === threadId);
        if (thread) {
            if (disposition) {
                thread.disposition = disposition;
            } else {
                delete thread.disposition;
            }
            this.saveComments(comments);
        }
    }

    deleteComment(threadId: string, commentId: string): void {
        const comments = this.loadComments();
        if (!comments) { return; }

        const thread = comments.threads.find(t => t.id === threadId);
        if (!thread) { return; }

        thread.comments = thread.comments.filter(c => c.id !== commentId);

        // If no comments left, remove the thread
        if (thread.comments.length === 0) {
            comments.threads = comments.threads.filter(t => t.id !== threadId);
        }

        this.saveComments(comments);
    }

    editComment(threadId: string, commentId: string, newBody: string): void {
        const comments = this.loadComments();
        if (!comments) { return; }

        const thread = comments.threads.find(t => t.id === threadId);
        if (!thread) { return; }

        const comment = thread.comments.find(c => c.id === commentId);
        if (comment) {
            comment.body = newBody;
            comment.timestamp = new Date().toISOString();
            this.saveComments(comments);
        }
    }

    getAllCommentFiles(): { reviewLabel: string; filePath: string }[] {
        const reviews = this.localPrManager.listReviews();
        const files: { reviewLabel: string; filePath: string }[] = [];

        for (const review of reviews) {
            const commentsPath = this.localPrManager.getCommentsFilePath(review);
            if (fs.existsSync(commentsPath)) {
                files.push({
                    reviewLabel: `${review.targetBranch} -> ${review.sourceBranch}`,
                    filePath: commentsPath,
                });
            }
        }

        return files;
    }

    getActiveReviewLabel(): string | undefined {
        const review = this.localPrManager.getActiveReview();
        if (!review) { return undefined; }
        return `${review.targetBranch} -> ${review.sourceBranch}`;
    }
}
