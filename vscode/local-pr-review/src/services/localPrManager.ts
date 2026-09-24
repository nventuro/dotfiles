import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { LocalPr, LocalPrRegistry, ReviewMode, CommentsFile } from '../types';

// Synthetic source for the single per-branch review. The diff mode is just a view
// field on it now, not part of the key — so comments are shared across both views.
const REVIEW_SOURCE = 'review';
// Legacy per-mode sources, collapsed into REVIEW_SOURCE by migrate().
const LEGACY_SOURCES = ['uncommitted', 'branch-base'];
import { GitService } from '../git/gitService';

export class LocalPrManager {
    private registry: LocalPrRegistry = { version: 1, reviews: [] };
    private registryPath: string;
    private reviewsDir: string;

    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(
        private gitService: GitService,
        workspaceRoot: string
    ) {
        this.reviewsDir = path.join(workspaceRoot, '.vscode', 'local-reviews');
        this.registryPath = path.join(this.reviewsDir, 'registry.json');
        this.loadRegistry();
        this.migrate();
        this.resetAnchorsOnce();
    }

    /**
     * Drop every comment anchor once, on upgrade. v0.3.17 created anchors by
     * guessing the "original code" from the CURRENT file, which was wrong for any
     * comment whose code had already changed (it showed the drifted code as the
     * original). v0.3.18 only sets anchors when it actually knows them (local
     * create-time, or a GitHub diff_hunk), so the guessed ones must go. Idempotent
     * via the registry flag — re-derived correctly on next create / re-import.
     */
    private resetAnchorsOnce(): void {
        if (this.registry.anchorsReset) { return; }
        for (const review of this.registry.reviews) {
            const dir = this.getReviewDir(review);
            const c = this.readCommentsFile(dir);
            if (!c) { continue; }
            let changed = false;
            for (const t of c.threads) {
                if (t.anchor) { delete t.anchor; changed = true; }
            }
            if (changed) { this.writeCommentsFile(dir, c); }
        }
        this.registry.anchorsReset = true;
        this.saveRegistry();
    }

    private loadRegistry(): void {
        try {
            if (fs.existsSync(this.registryPath)) {
                const data = fs.readFileSync(this.registryPath, 'utf-8');
                this.registry = JSON.parse(data);
            }
        } catch {
            this.registry = { version: 1, reviews: [] };
        }
    }

    /**
     * Re-read registry.json from disk. The registry is held in memory and only
     * refreshed on our own writes, so an external tool that creates or switches
     * a review is invisible until this
     * is called.
     */
    reloadRegistry(): void {
        this.loadRegistry();
    }

    private saveRegistry(): void {
        if (!fs.existsSync(this.reviewsDir)) {
            fs.mkdirSync(this.reviewsDir, { recursive: true });
        }
        // Atomic write: registry.json is the single source of truth for ALL reviewed
        // state (every branch's reviewedFiles + watermarks), so a crash mid-write would
        // truncate it and lose everything. Stage to a temp file then rename over the
        // target — a same-dir rename is atomic on POSIX, so a reader sees the old or the
        // new file, never a partial one.
        const tmp = this.registryPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.registry, null, 2), 'utf-8');
        fs.renameSync(tmp, this.registryPath);
        this._onDidChange.fire();
    }

    async createReview(sourceBranch: string, targetBranch: string): Promise<LocalPr> {
        // Check if review already exists for this branch pair
        const existing = this.registry.reviews.find(
            r => r.sourceBranch === sourceBranch && r.targetBranch === targetBranch
        );
        if (existing) {
            this.setActiveReview(existing.id);
            return existing;
        }

        const sourceCommit = await this.gitService.getCommitHash(sourceBranch);
        const targetCommit = await this.gitService.getCommitHash(targetBranch);

        const review: LocalPr = {
            id: crypto.randomUUID(),
            sourceBranch,
            targetBranch,
            sourceCommit: sourceCommit.trim(),
            targetCommit: targetCommit.trim(),
            createdAt: new Date().toISOString(),
        };

        this.registry.reviews.push(review);
        this.registry.activeReviewId = review.id;
        this.saveRegistry();

        return review;
    }

    /**
     * The single review for the current branch (key `review/<branch>`), creating
     * and activating it on first use. The diff mode is a view field, set
     * separately via setReviewMode — it is NOT part of the key, so one comment
     * store is shared across both the uncommitted and whole-branch views.
     * Returns `created: true` only when a new review record was made (callers use
     * it to decide whether to load threads).
     */
    async ensureReview(currentBranch: string, defaultMode: ReviewMode = 'branch'): Promise<{ review: LocalPr; created: boolean }> {
        // Re-read from disk first so a review created externally is visible. Otherwise our stale
        // in-memory registry wouldn't match it, we'd append a duplicate, and the
        // next saveRegistry would overwrite the on-disk record — dropping the
        // external review and orphaning its comments.
        this.loadRegistry();
        const targetBranch = currentBranch;
        const existing = this.registry.reviews.find(
            r => r.sourceBranch === REVIEW_SOURCE && r.targetBranch === targetBranch
        );
        if (existing) {
            this.setActiveReview(existing.id);
            return { review: existing, created: false };
        }

        let head = '';
        try {
            head = (await this.gitService.getCommitHash('HEAD')).trim();
        } catch { /* detached or empty repo — leave blank */ }

        const review: LocalPr = {
            id: crypto.randomUUID(),
            sourceBranch: REVIEW_SOURCE,
            targetBranch,
            sourceCommit: head,
            targetCommit: head,
            createdAt: new Date().toISOString(),
            mode: defaultMode,
            reviewedFiles: [],
        };

        this.registry.reviews.push(review);
        this.registry.activeReviewId = review.id;
        this.saveRegistry();

        return { review, created: true };
    }

    /** Set a review's current view mode (uncommitted vs whole-branch). */
    setReviewMode(id: string, mode: ReviewMode): void {
        const review = this.registry.reviews.find(r => r.id === id);
        if (review && review.mode !== mode) {
            review.mode = mode;
            this.saveRegistry();
        }
    }

    /**
     * Collapse legacy per-mode reviews (`uncommitted/<b>`, `branch-base/<b>`) into
     * one unified review (`review/<b>`) per branch, merging their comment threads
     * (union by id) and reviewedFiles, then dropping the legacy records + dirs.
     * Idempotent: a no-op once no legacy reviews remain.
     */
    private migrate(): void {
        const isLegacy = (r: LocalPr) => LEGACY_SOURCES.includes(r.sourceBranch);
        const legacy = this.registry.reviews.filter(isLegacy);
        if (legacy.length === 0) { return; }

        for (const branch of [...new Set(legacy.map(r => r.targetBranch))]) {
            const group = legacy.filter(r => r.targetBranch === branch);
            const wasActive = group.some(r => r.id === this.registry.activeReviewId);

            let unified = this.registry.reviews.find(
                r => r.sourceBranch === REVIEW_SOURCE && r.targetBranch === branch
            );
            if (!unified) {
                const branchView = group.find(r => r.sourceBranch === 'branch-base');
                unified = {
                    id: crypto.randomUUID(),
                    sourceBranch: REVIEW_SOURCE,
                    targetBranch: branch,
                    sourceCommit: group[0].sourceCommit,
                    targetCommit: group[0].targetCommit,
                    createdAt: group[0].createdAt,
                    mode: branchView?.mode ?? 'branch',
                    reviewedFiles: [],
                };
                this.registry.reviews.push(unified);
            }

            const unifiedDir = this.getReviewDir(unified);
            const merged = this.readCommentsFile(unifiedDir) ?? this.emptyComments(unified);
            const seen = new Set(merged.threads.map(t => t.id));
            const reviewed = new Set(unified.reviewedFiles ?? []);
            for (const r of group) {
                const c = this.readCommentsFile(this.getReviewDir(r));
                for (const t of c?.threads ?? []) {
                    if (!seen.has(t.id)) { merged.threads.push(t); seen.add(t.id); }
                }
                for (const f of (r.reviewedFiles ?? [])) { reviewed.add(f); }
                this.deleteReviewDir(r);
            }
            unified.reviewedFiles = [...reviewed];
            if (merged.threads.length > 0) { this.writeCommentsFile(unifiedDir, merged); }
            if (wasActive) { this.registry.activeReviewId = unified.id; }
        }

        this.registry.reviews = this.registry.reviews.filter(r => !isLegacy(r));
        this.saveRegistry();
    }

    private readCommentsFile(dir: string): CommentsFile | undefined {
        const p = path.join(dir, 'comments.json');
        try {
            if (fs.existsSync(p)) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
        } catch { /* ignore */ }
        return undefined;
    }

    private writeCommentsFile(dir: string, data: CommentsFile): void {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify(data, null, 2), 'utf-8');
    }

    private deleteReviewDir(review: LocalPr): void {
        const dir = this.getReviewDir(review);
        try {
            if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true }); }
        } catch { /* ignore */ }
    }

    private emptyComments(review: LocalPr): CommentsFile {
        return {
            version: 1,
            sourceBranch: review.sourceBranch,
            targetBranch: review.targetBranch,
            sourceCommit: review.sourceCommit,
            targetCommit: review.targetCommit,
            threads: [],
        };
    }

    deleteReview(id: string): void {
        const review = this.registry.reviews.find(r => r.id === id);
        if (!review) { return; }

        // Remove comments directory
        const commentsDir = this.getReviewDir(review);
        if (fs.existsSync(commentsDir)) {
            fs.rmSync(commentsDir, { recursive: true });
        }

        this.registry.reviews = this.registry.reviews.filter(r => r.id !== id);
        if (this.registry.activeReviewId === id) {
            this.registry.activeReviewId = undefined;
        }
        this.saveRegistry();
    }

    setActiveReview(id: string): void {
        this.registry.activeReviewId = id;
        this.saveRegistry();
    }

    getActiveReview(): LocalPr | undefined {
        if (!this.registry.activeReviewId) { return undefined; }
        return this.registry.reviews.find(r => r.id === this.registry.activeReviewId);
    }

    listReviews(): LocalPr[] {
        return this.registry.reviews;
    }

    findReviewByBranch(branch: string): LocalPr | undefined {
        return this.registry.reviews.find(
            r => r.targetBranch === branch || r.sourceBranch === branch
        );
    }

    getReviewDir(review: LocalPr): string {
        const dirName = `${review.sourceBranch}_${review.targetBranch}`.replace(/\//g, '-');
        return path.join(this.reviewsDir, dirName);
    }

    getCommentsFilePath(review: LocalPr): string {
        return path.join(this.getReviewDir(review), 'comments.json');
    }

    getReviewedFiles(): string[] {
        const review = this.getActiveReview();
        return review?.reviewedFiles || [];
    }

    /** The user-chosen base ref for the active review, or undefined for auto-detect. */
    getBaseOverride(): string | undefined {
        return this.getActiveReview()?.baseRef || undefined;
    }

    /** Set (or clear, with undefined) the active review's base ref and persist it. */
    setBaseOverride(ref: string | undefined): void {
        const review = this.getActiveReview();
        if (!review) { return; }
        if (ref) {
            review.baseRef = ref;
        } else {
            delete review.baseRef;
        }
        this.saveRegistry();
    }

    getReviewedHashes(): { [filePath: string]: string } {
        const review = this.getActiveReview();
        return review?.reviewedHashes || {};
    }

    /** Persist the reviewed-file set and their content fingerprints in one write. */
    setReviewedState(files: string[], hashes: { [filePath: string]: string }): void {
        const review = this.getActiveReview();
        if (review) {
            review.reviewedFiles = files;
            review.reviewedHashes = hashes;
            this.saveRegistry();
        }
    }

    /** The merge-base the reviewed snapshots were last rebased against, if recorded. */
    getReconciledBase(): string | undefined {
        return this.getActiveReview()?.reconciledBase;
    }

    /** Record the merge-base the snapshots are now current against. */
    setReconciledBase(ref: string): void {
        const review = this.getActiveReview();
        if (review) {
            review.reconciledBase = ref;
            this.saveRegistry();
        }
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
