import * as vscode from "vscode";
import { FileChange, CommitInfo } from "../types";
import { GitService, DiffHunk } from "../git/gitService";
import { StorageService } from "../storage/storageService";
import { stageOf } from "../stage";
import { LocalPrManager } from "../services/localPrManager";

export type ChangedFileTreeItem =
  | SectionItem
  | FileChangeItem
  | CommitItem
  | MessageItem;

type SectionType = "toReview" | "reviewed" | "commits";

export class ChangedFilesProvider
  implements vscode.TreeDataProvider<ChangedFileTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    ChangedFileTreeItem | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private files: FileChange[] = [];
  private commits: CommitInfo[] = [];
  private baseRef: string = "";
  private hasActiveReview = false;
  private reviewedFiles: Set<string> = new Set();
  // Per path: the blob sha of the content you LAST reviewed — a "watermark". The
  // blob is written to the object store (blessFile), so it survives as the left
  // side of the increment diff. RETAINED after a content change auto-unreviews the
  // file (so re-review shows only the delta); cleared only by a manual uncheck.
  private reviewedHashes: Map<string, string> = new Map();
  // Current working-tree blob hash per changed path, recomputed each refresh and
  // compared against reviewedHashes to auto-unreview files whose content changed.
  private currentHashes: Map<string, string> = new Map();
  // Files no longer reviewed but with a usable watermark differing from their
  // current content → path : blessed-blob sha. Their diff shows last-reviewed ↔
  // working (the change since you reviewed), not base ↔ working. Recomputed each
  // refresh (blob-existence checked, so a GC'd/missing snapshot drops out cleanly).
  private incrementBases: Map<string, string> = new Map();
  // Partially-reviewed files → how many hunks still remain (snapshot ≠ working but
  // not unreviewed). Drives the "· N to review" hint on the row.
  private partialHunkCounts: Map<string, number> = new Map();

  private sections: SectionItem[] = [];
  private parents = new Map<ChangedFileTreeItem, ChangedFileTreeItem>();

  constructor(
    private gitService: GitService,
    private storageService: StorageService,
    private localPrManager: LocalPrManager,
  ) {
    this.reviewedFiles = new Set(localPrManager.getReviewedFiles());
    this.reviewedHashes = new Map(
      Object.entries(localPrManager.getReviewedHashes()),
    );
  }

  getTreeItem(element: ChangedFileTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ChangedFileTreeItem): ChangedFileTreeItem[] {
    if (!element) {
      return this.buildRootSections();
    }
    if (element instanceof SectionItem) {
      return element.getChildren();
    }
    return [];
  }

  getParent(element: ChangedFileTreeItem): ChangedFileTreeItem | undefined {
    return this.parents.get(element);
  }

  getBaseRef(): string {
    return this.baseRef;
  }

  private buildRootSections(): ChangedFileTreeItem[] {
    this.sections = [];
    this.parents.clear();

    if (this.files.length === 0 && this.commits.length === 0) {
      if (!this.hasActiveReview) {
        return [];
      }
      return [new MessageItem("No changes vs the base branch")];
    }

    // Group by REVIEW STATUS, not git stage. "To Review" is every file not yet
    // fully reviewed; "Reviewed" is every file with anything blessed. A partially
    // reviewed file (incrementBases) satisfies both, so it appears in BOTH sections
    // with a ● bullet — its To Review copy diffs snapshot ↔ working (what's left),
    // its Reviewed copy base ↔ snapshot (what you've blessed).
    const toReview = this.files.filter(
      (f) => !this.reviewedFiles.has(f.filePath),
    );
    const reviewed = this.files.filter(
      (f) =>
        this.reviewedFiles.has(f.filePath) ||
        this.incrementBases.has(f.filePath),
    );

    if (toReview.length > 0) {
      const section = new SectionItem(
        "To Review",
        "toReview",
        this.buildFileList(toReview, false),
        toReview.length,
      );
      this.registerSectionChildren(section);
      this.sections.push(section);
    }
    if (reviewed.length > 0) {
      const section = new SectionItem(
        "Reviewed",
        "reviewed",
        this.buildFileList(reviewed, true),
        reviewed.length,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      this.registerSectionChildren(section);
      this.sections.push(section);
    }

    if (this.commits.length > 0) {
      const commitsSection = new SectionItem(
        "Commits",
        "commits",
        this.buildCommitList(),
        this.commits.length,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      this.registerSectionChildren(commitsSection);
      this.sections.push(commitsSection);
    }
    return this.sections;
  }

  private registerSectionChildren(section: SectionItem): void {
    for (const child of section.getChildren()) {
      this.parents.set(child, section);
    }
  }

  /** Flat SCM-style list: one row per file, sorted by full path. `reviewedView`
   *  tags each row as the Reviewed-section copy (opens base ↔ snapshot). */
  private buildFileList(
    files: FileChange[],
    reviewedView: boolean,
  ): ChangedFileTreeItem[] {
    const commentCounts = this.getCommentCounts();
    return [...files]
      .sort((a, b) => a.filePath.localeCompare(b.filePath))
      .map((f) => this.createFileItem(f, commentCounts, reviewedView));
  }

  private buildCommitList(): CommitItem[] {
    return this.commits.map((c) => new CommitItem(c));
  }

  private createFileItem(
    file: FileChange,
    commentCounts: Map<string, number>,
    reviewedView: boolean,
  ): FileChangeItem {
    // A partially-reviewed file (snapshot between base and working) gets the ●
    // bullet in both sections.
    const partial = this.incrementBases.has(file.filePath);
    const item = new FileChangeItem(
      file,
      commentCounts.get(file.filePath) || 0,
      partial,
      this.partialHunkCounts.get(file.filePath),
      reviewedView,
    );
    item.checkboxState = this.reviewedFiles.has(file.filePath)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    return item;
  }

  private getCommentCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    const comments = this.storageService.loadComments();
    if (comments) {
      for (const thread of comments.threads) {
        // The per-file badge is a "needs your attention" signal, so it counts
        // only To do threads.
        if (stageOf(thread) === "todo") {
          counts.set(thread.filePath, (counts.get(thread.filePath) || 0) + 1);
        }
      }
    }
    return counts;
  }

  async setFileReviewed(filePath: string, checked: boolean): Promise<void> {
    if (checked) {
      // Snapshot before mutating: a debounced refresh() landing in the await would
      // replace reviewedFiles/reviewedHashes from storage and drop the mark (the
      // same race reviewAll guards against; callers loop this over multi-selects).
      const sha = await this.snapshotFile(filePath);
      this.reviewedFiles.add(filePath);
      if (sha !== undefined) {
        this.reviewedHashes.set(filePath, sha);
      }
      // Current content is now the watermark → no increment to show.
      this.incrementBases.delete(filePath);
    } else {
      // Manual uncheck = full reset: drop membership AND the watermark, so this
      // is treated as never-reviewed (no increment diff). A CONTENT-change
      // unreview keeps the watermark — that path is reconcileReviewed, not here.
      this.reviewedFiles.delete(filePath);
      this.reviewedHashes.delete(filePath);
      this.incrementBases.delete(filePath);
    }
    this.persistReviewed();
  }

  /**
   * Snapshot a file's current content as its review watermark: write the blob to
   * the object store (so the increment diff can read it later) and record its sha.
   * Falls back to the current hash if the write fails (file gone) — membership
   * still tracks; the increment diff just degrades to the full base diff.
   */
  private async bless(filePath: string): Promise<void> {
    const sha = await this.snapshotFile(filePath);
    if (sha !== undefined) {
      this.reviewedHashes.set(filePath, sha);
    }
  }

  /** Snapshot a file's current content and return its watermark sha, without
   *  touching provider state (so callers can batch awaits, then apply atomically). */
  private async snapshotFile(filePath: string): Promise<string | undefined> {
    const sha = await this.gitService.blessFile(filePath);
    if (sha) {
      return sha;
    }
    return this.currentHashes.get(filePath);
  }

  /**
   * Content of a file's reviewed snapshot R: the stored snapshot blob, or — when
   * nothing's been reviewed yet — the base content the diff is against (so the first
   * hunk you bless is measured from base, and R interpolates base → working).
   */
  async getReviewedSnapshotContent(filePath: string): Promise<string> {
    const sha = this.reviewedHashes.get(filePath);
    if (sha) {
      return this.gitService.getBlobContent(sha);
    }
    return this.getBaseContent(filePath);
  }

  /** The reviewed-snapshot blob sha for a file, or undefined (nothing reviewed). */
  getReviewedSnapshotSha(filePath: string): string | undefined {
    return this.reviewedHashes.get(filePath);
  }

  /** The base side the diff is measured against: the branch's merge-base ('' for a
   *  file absent there — new/untracked — so every line reads as added). */
  private getBaseContent(filePath: string): Promise<string> {
    return this.gitService.getFileContent(this.baseRef || "HEAD", filePath);
  }

  /** Splice one hunk's working-side lines into the snapshot at its old range. */
  private applyHunk(lines: string[], h: DiffHunk): string[] {
    const out = [...lines];
    if (h.oldCount === 0) {
      out.splice(h.oldStart, 0, ...h.newLines); // insertion after line oldStart
    } else {
      out.splice(h.oldStart - 1, h.oldCount, ...h.newLines); // replace / delete
    }
    return out;
  }

  /**
   * Advance a file's reviewed snapshot over the hunk at (or nearest to) working
   * `line` — the line of the change the quick-diff peek's "Mark reviewed" was
   * clicked on. Splices that one change into R, writes the new blob, stores it; if R
   * now equals working the whole file is reviewed. Persists; caller refreshes.
   */
  async markHunkAtLine(
    filePath: string,
    line: number,
    side: "new" | "old" = "new",
  ): Promise<void> {
    const content = await this.getReviewedSnapshotContent(filePath);
    const hunks = await this.gitService.getHunks(content, filePath);
    if (hunks.length === 0) {
      return;
    }
    // Match against the new (working / right pane) side, or the old (reviewed /
    // left pane) side — the latter so a pure DELETION, whose lines exist only on
    // the left, can be marked by clicking the removed lines there.
    const span = (h: DiffHunk): [number, number] =>
      side === "old"
        ? [
            h.oldStart,
            h.oldCount > 0 ? h.oldStart + h.oldCount - 1 : h.oldStart,
          ]
        : [
            h.newStart,
            h.newCount > 0 ? h.newStart + h.newCount - 1 : h.newStart,
          ];
    const key = (h: DiffHunk) => (side === "old" ? h.oldStart : h.newStart);
    // ±1 tolerance so an empty-side anchor (deletion/insertion) still matches; fall
    // back to the nearest hunk since the click was on a real change.
    const contains = (h: DiffHunk) => {
      const [s, e] = span(h);
      return line >= s - 1 && line <= e + 1;
    };
    const hunk =
      hunks.find(contains) ??
      hunks.reduce((a, b) =>
        Math.abs(key(b) - line) < Math.abs(key(a) - line) ? b : a,
      );
    const next = this.applyHunk(content.split("\n"), hunk).join("\n");
    const sha = await this.gitService.writeBlob(next, filePath);
    this.reviewedHashes.set(filePath, sha);
    await this.markFullyIfComplete(filePath, sha);
    this.persistReviewed();
  }

  /**
   * Mark every hunk that overlaps the line range [startLine, endLine] (1-based) on
   * the given side — a multi-line selection. Select-all then mark = the whole file.
   * Applies one hunk per pass (recomputing, since each advances the snapshot) until
   * none overlap.
   */
  async markHunksInRange(
    filePath: string,
    startLine: number,
    endLine: number,
    side: "new" | "old" = "new",
  ): Promise<void> {
    const lo = Math.min(startLine, endLine);
    const hi = Math.max(startLine, endLine);
    const span = (h: DiffHunk): [number, number] =>
      side === "old"
        ? [
            h.oldStart,
            h.oldCount > 0 ? h.oldStart + h.oldCount - 1 : h.oldStart,
          ]
        : [
            h.newStart,
            h.newCount > 0 ? h.newStart + h.newCount - 1 : h.newStart,
          ];
    let sha: string | undefined;
    for (let guard = 0; guard < 5000; guard++) {
      const content = await this.getReviewedSnapshotContent(filePath);
      const hunks = await this.gitService.getHunks(content, filePath);
      const hunk = hunks.find((h) => {
        const [s, e] = span(h);
        return s - 1 <= hi && e + 1 >= lo;
      });
      if (!hunk) {
        break;
      }
      const next = this.applyHunk(content.split("\n"), hunk).join("\n");
      sha = await this.gitService.writeBlob(next, filePath);
      this.reviewedHashes.set(filePath, sha);
    }
    if (sha !== undefined) {
      await this.markFullyIfComplete(filePath, sha);
      this.persistReviewed();
    }
  }

  /** Promote a file to fully reviewed once its snapshot caught up to working. */
  private async markFullyIfComplete(
    filePath: string,
    snapshotSha: string,
  ): Promise<void> {
    const cur = (await this.gitService.hashWorkingFiles([filePath])).get(
      filePath,
    );
    if (cur && cur === snapshotSha) {
      this.reviewedFiles.add(filePath);
    } else {
      this.reviewedFiles.delete(filePath);
    }
  }

  /** For each partially-reviewed file (snapshot ≠ working), how many hunks remain.
   *  Only the few partial files (incrementBases) are diffed, so this stays cheap. */
  private async computePartialCounts(): Promise<void> {
    const next = new Map<string, number>();
    for (const filePath of this.incrementBases.keys()) {
      const content = await this.getReviewedSnapshotContent(filePath);
      const n = (await this.gitService.getHunks(content, filePath)).length;
      if (n > 0) {
        next.set(filePath, n);
      }
    }
    this.partialHunkCounts = next;
  }

  private persistReviewed(): void {
    this.localPrManager.setReviewedState(
      Array.from(this.reviewedFiles),
      Object.fromEntries(this.reviewedHashes),
    );
  }

  /** Files currently marked reviewed (for the "Unmark all reviewed" confirm). */
  reviewedCount(): number {
    return this.reviewedFiles.size;
  }

  /** Fully-reviewed file paths — the "Reviewed" SCM resource group + bucket. */
  getReviewedFilePaths(): string[] {
    return [...this.reviewedFiles];
  }

  /** Partially-reviewed file paths (some hunks blessed) — appear in BOTH sections. */
  getPartialFilePaths(): string[] {
    return [...this.incrementBases.keys()];
  }

  /** How many files are not yet fully reviewed — the "To Review" count (drives the
   *  activity-bar badge). Partials still count as to-review. */
  toReviewCount(): number {
    return this.files.filter((f) => !this.reviewedFiles.has(f.filePath)).length;
  }

  /** Clear every reviewed mark — the "Unmark all reviewed" button on the Reviewed section. */
  unreviewAll(): void {
    if (this.reviewedFiles.size === 0) {
      return;
    }
    this.reviewedFiles.clear();
    this.reviewedHashes.clear();
    this.incrementBases.clear();
    this.persistReviewed();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Mark every not-yet-reviewed changed file reviewed — the "Mark all reviewed" button
   *  on the To Review section. Blesses each file's current content (so a partial file
   *  becomes fully reviewed), then persists once. */
  async reviewAll(): Promise<void> {
    const toReview = this.files.filter(
      (f) => !this.reviewedFiles.has(f.filePath),
    );
    if (toReview.length === 0) {
      return;
    }
    // Snapshot every file BEFORE mutating any state: dismissing the confirm modal
    // refocuses the window, which schedules a debounced refresh() that replaces
    // reviewedFiles/reviewedHashes from storage — landing mid-loop, it would drop
    // every mark made before it. Batch the awaits, then apply + persist in one
    // synchronous block so no refresh can interleave.
    const blessed = new Map<string, string | undefined>();
    for (const f of toReview) {
      blessed.set(f.filePath, await this.snapshotFile(f.filePath));
    }
    for (const [filePath, sha] of blessed) {
      this.reviewedFiles.add(filePath);
      if (sha !== undefined) {
        this.reviewedHashes.set(filePath, sha);
      }
      this.incrementBases.delete(filePath);
    }
    this.persistReviewed();
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * When the review's merge-base advances — you merged or rebased the base branch
   * into your feature branch — replay the base's own edits into each reviewed
   * snapshot, so changes already in the (new) base branch stop showing as "to review".
   * Without this the snapshot is frozen at the old base and `snapshot ↔ working`
   * surfaces every base-branch edit to the file, not your work.
   *
   * Runs before reconcileReviewed so the reviewed/partial state is derived from the
   * rebased snapshots. The first time it sees a review it just records the current
   * base (the existing snapshots' base is unknown, so no retroactive rebase). A
   * conflict — a base edit overlapping your reviewed edit — resets that file's
   * snapshot to the new base, so you re-review only that one file.
   */
  private async rebaseSnapshotsIfBaseAdvanced(): Promise<void> {
    const base = this.baseRef;
    if (!base) {
      return;
    }
    const prev = this.localPrManager.getReconciledBase();
    if (!prev) {
      this.localPrManager.setReconciledBase(base);
      return;
    }
    if (prev === base) {
      return;
    }

    let changed = false;
    for (const [filePath, sha] of [...this.reviewedHashes]) {
      const ours = await this.gitService.getBlobContent(sha);
      // Snapshot gone → getReviewedSnapshotContent already falls back to live base.
      if (!ours) {
        continue;
      }
      const [oldBase, newBase] = await Promise.all([
        this.gitService.getFileContent(prev, filePath),
        this.gitService.getFileContent(base, filePath),
      ]);
      if (oldBase === newBase) {
        continue;
      } // the base branch didn't touch this file
      const { content, clean } = await this.gitService.threeWayMerge(
        ours,
        oldBase,
        newBase,
      );
      const nextSha = await this.gitService.writeBlob(
        clean ? content : newBase,
        filePath,
      );
      if (nextSha && nextSha !== sha) {
        this.reviewedHashes.set(filePath, nextSha);
        changed = true;
      }
    }
    if (changed) {
      this.persistReviewed();
    }
    this.localPrManager.setReconciledBase(base);
  }

  /**
   * GitHub "Viewed"-style staleness: a file whose working content changed since you
   * reviewed it is no longer reviewed (drops from the bucket back to the active
   * list). Unlike a plain evict, the watermark (reviewedHashes) is KEPT, so the
   * file's diff then shows only the change since you reviewed (see
   * computeIncrementBases), not the whole base diff. A reviewed path with no
   * watermark yet — upgraded from before snapshots — is blessed (snapshots current,
   * writes the blob). Paths not in the changeset are left untouched. Returns true if
   * the reviewed set or watermarks changed, so the caller can persist.
   */
  private async reconcileReviewed(): Promise<boolean> {
    let changed = false;
    for (const filePath of [...this.reviewedFiles]) {
      const current = this.currentHashes.get(filePath);
      if (current === undefined) {
        continue;
      }
      const stored = this.reviewedHashes.get(filePath);
      if (stored === undefined) {
        await this.bless(filePath);
        changed = true;
      } else if (stored !== current) {
        // Changed since reviewed → no longer reviewed, but KEEP the watermark.
        this.reviewedFiles.delete(filePath);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Resolve which files get the increment diff: not currently reviewed, in the
   * changeset, with a retained watermark that differs from the current content AND
   * whose blessed blob still exists in the object store (a snapshot can be GC'd, or
   * predate the write-blob upgrade — those drop out and fall back to the full diff).
   */
  private async computeIncrementBases(): Promise<void> {
    const next = new Map<string, string>();
    const inChangeset = new Set(this.files.map((f) => f.filePath));
    for (const [filePath, sha] of this.reviewedHashes) {
      if (this.reviewedFiles.has(filePath)) {
        continue;
      }
      if (!inChangeset.has(filePath)) {
        continue;
      }
      if (sha === this.currentHashes.get(filePath)) {
        continue;
      }
      if (await this.gitService.blobExists(sha)) {
        next.set(filePath, sha);
      }
    }
    this.incrementBases = next;
  }

  /**
   * The blessed-snapshot blob sha to diff a file against (last reviewed ↔ working),
   * or undefined for a normal base diff. Read by computeDiffUris in extension.ts.
   */
  getIncrementBase(filePath: string): string | undefined {
    return this.incrementBases.get(filePath);
  }

  /** Recompute the changed-file list (always whole-branch vs merge-base). */
  async refresh(): Promise<void> {
    this.reviewedFiles = new Set(this.localPrManager.getReviewedFiles());
    this.reviewedHashes = new Map(
      Object.entries(this.localPrManager.getReviewedHashes()),
    );
    const review = this.localPrManager.getActiveReview();
    this.hasActiveReview = !!review;

    if (!review) {
      this.files = [];
      this.commits = [];
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    try {
      this.baseRef = await this.gitService.resolveBranchBase(
        this.localPrManager.getBaseOverride(),
      );
      const [tracked, untracked, commits] = await Promise.all([
        this.gitService.getBranchFiles(this.baseRef),
        this.gitService.getUntrackedFiles(),
        this.gitService.getCommitsBetween(this.baseRef, "HEAD"),
      ]);
      this.files = [...tracked, ...untracked];
      this.commits = commits;
    } catch (e: any) {
      vscode.window.showErrorMessage(
        `Failed to get changed files: ${e.message}`,
      );
      this.files = [];
      this.commits = [];
    }

    // If the merge-base moved (you merged/rebased the base branch in), replay the
    // base delta into each reviewed snapshot so base-branch changes don't resurface
    // as "to review". Must run before reconcile, which derives state from snapshots.
    await this.rebaseSnapshotsIfBaseAdvanced();

    // Fingerprint the current changeset and auto-unreview any file whose content
    // drifted from what was reviewed. Persist only when something actually changed.
    this.currentHashes = await this.gitService.hashWorkingFiles(
      this.files.map((f) => f.filePath),
    );
    if (await this.reconcileReviewed()) {
      this.persistReviewed();
    }
    await this.computeIncrementBases();
    await this.computePartialCounts();

    this._onDidChangeTreeData.fire(undefined);
  }

  getAllExpandableItems(): ChangedFileTreeItem[] {
    return [...this.sections];
  }

  getAllFileItems(): FileChangeItem[] {
    const items: FileChangeItem[] = [];
    for (const section of this.sections) {
      for (const child of section.getChildren()) {
        if (child instanceof FileChangeItem) {
          items.push(child);
        }
      }
    }
    return items;
  }

  /**
   * Get all changed file paths directly (not dependent on tree rendering).
   */
  getAllFilePaths(): string[] {
    return this.files.map((f) => f.filePath);
  }

  /**
   * Build a FileChangeItem for a path from the current change set, independent of
   * whether the tree has been expanded/rendered. When a path appears under several
   * stages (a partially-staged file), prefer the working-tree side
   * (unstaged → untracked → staged) so the diff shows current content — and, for an
   * unstaged file, opens the native diff with the stage gutter + comments.
   * Returns undefined when the path isn't part of the active review's changes.
   */
  findFileItem(filePath: string): FileChangeItem | undefined {
    const matches = this.files.filter((f) => f.filePath === filePath);
    if (matches.length === 0) {
      return undefined;
    }
    const rank: Record<string, number> = {
      unstaged: 0,
      untracked: 1,
      staged: 2,
    };
    const chosen = [...matches].sort(
      (a, b) => (rank[a.stage ?? ""] ?? 3) - (rank[b.stage ?? ""] ?? 3),
    )[0];
    const count = this.getCommentCounts().get(filePath) || 0;
    return new FileChangeItem(chosen, count);
  }

  clear(): void {
    this.files = [];
    this.commits = [];
    this.hasActiveReview = false;
    this.reviewedFiles.clear();
    this.reviewedHashes.clear();
    this.currentHashes.clear();
    this.incrementBases.clear();
    this.partialHunkCounts.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  fireChange(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

export class SectionItem extends vscode.TreeItem {
  private children: ChangedFileTreeItem[];

  constructor(
    label: string,
    public readonly sectionType: SectionType,
    children: ChangedFileTreeItem[],
    count: number,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode
      .TreeItemCollapsibleState.Expanded,
  ) {
    super(label, collapsibleState);
    this.children = children;
    this.description = `${count}`;
    this.contextValue = `section.${sectionType}`;
    this.iconPath = SectionItem.iconFor(sectionType);
  }

  private static iconFor(sectionType: SectionType): vscode.ThemeIcon {
    switch (sectionType) {
      case "commits":
        return new vscode.ThemeIcon("git-commit");
      case "reviewed":
        return new vscode.ThemeIcon("verified");
      case "toReview":
        return new vscode.ThemeIcon("edit");
      default:
        return new vscode.ThemeIcon("files");
    }
  }

  getChildren(): ChangedFileTreeItem[] {
    return this.children;
  }
}

export class FileChangeItem extends vscode.TreeItem {
  constructor(
    public readonly fileChange: FileChange,
    public readonly commentCount: number = 0,
    partial: boolean = false,
    hunksLeft?: number,
    public readonly reviewedView: boolean = false,
  ) {
    const fp = fileChange.filePath;
    const slashIdx = fp.lastIndexOf("/");
    const baseName = slashIdx === -1 ? fp : fp.substring(slashIdx + 1);
    const dirName = slashIdx === -1 ? "" : fp.substring(0, slashIdx);
    // A partially-reviewed file (present in BOTH To Review and Reviewed) gets a ●
    // before the name — some hunks blessed, some still to review.
    super(
      partial ? `● ${baseName}` : baseName,
      vscode.TreeItemCollapsibleState.None,
    );

    // resourceUri + no iconPath → the active file icon theme renders the
    // file-type icon (the VS Code SCM look). Status is shown by the
    // FileDecorationProvider (letter + colour), comments by its badge.
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (workspaceRoot) {
      this.resourceUri = vscode.Uri.joinPath(workspaceRoot, fp);
    }
    // A file deleted on the branch has no working-tree path, so the built-in Git
    // decorator (which only marks working-tree changes) can't badge it and the
    // file-icon theme renders nothing. Mark the deletion explicitly.
    if (fileChange.status === "deleted") {
      this.iconPath = new vscode.ThemeIcon(
        "diff-removed",
        new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
      );
    }

    // Description: to-do comment counter FIRST (right after the file
    // name, so a long dir path can't push it off-screen), then the dimmed
    // dir path. Counter omitted entirely when the count is 0.
    const countLabel = commentCount > 0 ? `\u{1F4AC} ${commentCount}` : "";
    // "N to review" for a partially-reviewed file — first in the description so it
    // survives right-truncation on a narrow row.
    const hunksLabel = hunksLeft ? `${hunksLeft} to review` : "";
    this.description = [hunksLabel, countLabel, dirName]
      .filter(Boolean)
      .join(" · ");
    const stageNote = fileChange.stage ? ` (${fileChange.stage})` : "";
    const partialNote = partial ? " — partially reviewed" : "";
    this.tooltip =
      `${fileChange.status}${stageNote}: ${fp}` +
      partialNote +
      (commentCount > 0
        ? ` — ${commentCount} comment${commentCount > 1 ? "s" : ""} to do`
        : "");
    // The `.reviewed` suffix tags the Reviewed-section copy so it can carry a
    // "Mark not reviewed" action (the checkbox alone can't reset a partial file —
    // it's already unchecked there).
    this.contextValue = `fileChange.${fileChange.stage ?? "branch"}${reviewedView ? ".reviewed" : ""}`;

    this.command = {
      command: "localPrReview.openDiff",
      title: "Open Diff",
      arguments: [this],
    };
  }
}

export class CommitItem extends vscode.TreeItem {
  constructor(public readonly commit: CommitInfo) {
    super(commit.message, vscode.TreeItemCollapsibleState.None);
    this.description = commit.relativeDate;
    this.tooltip = `${commit.shortHash} by ${commit.author}\n${commit.message}\n${commit.relativeDate}`;
    this.iconPath = new vscode.ThemeIcon("git-commit");
    this.contextValue = "commit";
  }
}

export class MessageItem extends vscode.TreeItem {
  constructor(label: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = tooltip;
    this.iconPath = new vscode.ThemeIcon("info");
    this.contextValue = "message";
  }
}
