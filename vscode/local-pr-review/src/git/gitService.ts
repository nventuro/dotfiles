import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  FileChange,
  FileChangeStatus,
  GitApi,
  GitRepository,
  CommitInfo,
} from "../types";

/** One change region between a reviewed snapshot and the working file. `oldStart`/
 *  `oldCount` index the snapshot (1-based, git convention); `newLines` is the
 *  working-side content to splice in to advance the snapshot over this hunk. */
export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  newLines: string[];
}

export class GitService {
  private repo: GitRepository | undefined;
  private workspaceRoot: string;

  private _onDidChangeBranch = new vscode.EventEmitter<string>();
  readonly onDidChangeBranch = this._onDidChangeBranch.event;
  private _onDidChangeHead = new vscode.EventEmitter<void>();
  readonly onDidChangeHead = this._onDidChangeHead.event;
  // Fires on any repo state change (staging, index, working tree) — drives live
  // refresh of the staged/unstaged grouping in 'uncommitted' mode.
  private _onDidChangeState = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this._onDidChangeState.event;
  private _lastBranch: string | undefined;
  private _lastCommit: string | undefined;
  // Monotonic suffix for temp blob/base files, so concurrent writeBlob/getHunks
  // calls within the same millisecond don't collide on a filename.
  private tmpCounter = 0;

  constructor(private context: vscode.ExtensionContext) {
    this.workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  }

  async initialize(): Promise<boolean> {
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (!gitExtension) {
      vscode.window.showErrorMessage("Git extension not found");
      return false;
    }

    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }

    const api = gitExtension.exports.getAPI(1);

    // If repos are already available, use them
    if (api.repositories.length > 0) {
      this.repo = api.repositories[0];
      this._trackBranchChanges();
      return true;
    }

    // Wait for git extension to discover repositories (up to 10 seconds)
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        disposable.dispose();
        resolve(false);
      }, 10000);

      const disposable = api.onDidOpenRepository((repo: GitRepository) => {
        clearTimeout(timeout);
        disposable.dispose();
        this.repo = repo;
        this._trackBranchChanges();
        resolve(true);
      });
    });
  }

  private _trackBranchChanges(): void {
    if (!this.repo) {
      return;
    }
    this._lastBranch = this.repo.state.HEAD?.name;
    this._lastCommit = this.repo.state.HEAD?.commit;
    this.repo.state.onDidChange(() => {
      const current = this.repo?.state.HEAD?.name;
      const currentCommit = this.repo?.state.HEAD?.commit;
      if (current && current !== this._lastBranch) {
        this._lastBranch = current;
        this._lastCommit = currentCommit;
        this._onDidChangeBranch.fire(current);
      } else if (currentCommit && currentCommit !== this._lastCommit) {
        this._lastCommit = currentCommit;
        this._onDidChangeHead.fire();
      }
      this._onDidChangeState.fire();
    });
  }

  async getBranches(includeRemote: boolean = false): Promise<string[]> {
    if (!this.repo) {
      return [];
    }

    const localBranches = await this.repo.getBranches({ remote: false });
    const localNames = localBranches
      .map((b) => b.name)
      .filter((name): name is string => !!name);

    if (!includeRemote) {
      return localNames;
    }

    // Also include remote tracking branches (origin/*)
    try {
      const remoteBranches = await this.repo.getBranches({ remote: true });
      const remoteNames = remoteBranches
        .map((b) => b.name)
        .filter((name): name is string => !!name);
      const localSet = new Set(localNames);
      const uniqueRemote = remoteNames.filter((n) => !localSet.has(n));
      return [...localNames, ...uniqueRemote];
    } catch {
      return localNames;
    }
  }

  async getCurrentBranch(): Promise<string | undefined> {
    const fromApi = this.repo?.state.HEAD?.name;
    if (fromApi) {
      return fromApi;
    }
    // The built-in git extension can be slow to populate HEAD for a worktree
    // (its repo scan can outlast our initialize() timeout), leaving this.repo
    // null. Fall back to a direct rev-parse so review creation isn't silently
    // blocked. Returns undefined on a detached HEAD (matches the null-HEAD case).
    const branch = (
      await this.execGit("rev-parse --abbrev-ref HEAD").catch(() => "")
    ).trim();
    return branch && branch !== "HEAD" ? branch : undefined;
  }

  async getCommitHash(branch: string): Promise<string> {
    return this.execGit(`rev-parse ${branch}`);
  }

  async isCurrentBranch(branch: string): Promise<boolean> {
    const current = await this.getCurrentBranch();
    return current === branch;
  }

  async getChangedFiles(source: string, target: string): Promise<FileChange[]> {
    // If target is the current branch, compare against working tree (includes uncommitted changes)
    const isWorkingTree = await this.isCurrentBranch(target);
    const diffCmd = isWorkingTree
      ? `diff --name-status ${source}`
      : `diff --name-status ${source}...${target}`;
    const output = await this.execGit(diffCmd);
    return this.parseNameStatus(output);
  }

  private parseNameStatus(
    output: string,
    stage?: FileChange["stage"],
  ): FileChange[] {
    if (!output.trim()) {
      return [];
    }
    return output
      .trim()
      .split("\n")
      .map((line) => {
        const parts = line.split("\t");
        const statusChar = parts[0].charAt(0);
        const oldFilePath = parts.length > 2 ? parts[1] : undefined;
        const actualPath = parts.length > 2 ? parts[2] : parts[1];

        let status: FileChangeStatus;
        switch (statusChar) {
          case "A":
            status = "added";
            break;
          case "D":
            status = "deleted";
            break;
          case "R":
            status = "renamed";
            break;
          default:
            status = "modified";
            break;
        }

        return {
          status,
          filePath: actualPath,
          oldFilePath: status === "renamed" ? oldFilePath : undefined,
          stage,
        };
      });
  }

  /**
   * Resolve the base ref for 'branch' mode.
   *
   * A user-chosen `override` (e.g. the parent branch of a stacked branch) is tried
   * first, then the `localPrReview.defaultBase` setting, then the remote's default
   * branch (origin/HEAD), then origin/main and origin/master. Each candidate is
   * used as a merge-base with HEAD, so the diff stays correct as commits are
   * added; a candidate that exists but shares no history is used directly.
   * Falls back to HEAD (no diff) when nothing resolves.
   */
  async resolveBranchBase(override?: string): Promise<string> {
    const configured = vscode.workspace
      .getConfiguration("localPrReview")
      .get<string>("defaultBase", "")
      .trim();
    const candidates = [override, configured].filter((c): c is string => !!c);
    try {
      const def = (
        await this.execGit("symbolic-ref --short refs/remotes/origin/HEAD")
      ).trim();
      if (def) {
        candidates.push(def);
      }
    } catch {
      /* origin/HEAD not set locally */
    }
    candidates.push("origin/main", "origin/master");
    for (const c of candidates) {
      try {
        const mb = (await this.execGit(`merge-base ${c} HEAD`)).trim();
        if (mb) {
          return mb;
        }
      } catch {
        /* deleted/unrelated — try next */
      }
    }
    for (const c of candidates) {
      try {
        await this.execGit(`rev-parse --verify ${c}`);
        return c;
      } catch {
        /* not present locally */
      }
    }
    return "HEAD";
  }

  /**
   * Working-tree changes vs HEAD, split into staged / unstaged / untracked groups.
   * A partially-staged file legitimately appears in both staged and unstaged.
   */
  async getUncommittedFiles(): Promise<FileChange[]> {
    const [staged, unstaged, untracked] = await Promise.all([
      this.execGit("diff --name-status --cached").catch(() => ""),
      this.execGit("diff --name-status").catch(() => ""),
      this.getUntrackedFiles(),
    ]);

    return [
      ...this.parseNameStatus(staged, "staged"),
      ...this.parseNameStatus(unstaged, "unstaged"),
      ...untracked.map((f) => ({ ...f, stage: "untracked" as const })),
    ];
  }

  /** Whole-branch changes (committed + uncommitted) vs the resolved base. */
  async getBranchFiles(baseRef: string): Promise<FileChange[]> {
    const output = await this.execGit(`diff --name-status ${baseRef}`).catch(
      () => "",
    );
    return this.parseNameStatus(output);
  }

  /** New, not-yet-tracked files (relative paths from repo root). */
  async getUntrackedFiles(): Promise<FileChange[]> {
    const out = await this.execGit(
      "ls-files --others --exclude-standard",
    ).catch(() => "");
    if (!out.trim()) {
      return [];
    }
    return out
      .trim()
      .split("\n")
      .map((p) => ({ status: "added" as const, filePath: p }));
  }

  /**
   * Blob hash of each path's current working-tree content (`git hash-object`),
   * used as a content fingerprint for the reviewed-file staleness check. Paths
   * with no on-disk file (deleted) are omitted, and hash-object aborts the whole
   * batch on a missing path — so existing files are filtered first. Hashes come
   * back in input order, one per line.
   */
  async hashWorkingFiles(paths: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const existing = paths.filter((p) => {
      try {
        return fs.existsSync(path.join(this.workspaceRoot, p));
      } catch {
        return false;
      }
    });
    if (existing.length === 0) {
      return result;
    }
    const out = await this.execGit(
      `hash-object -- ${existing.map((p) => this.quoteArg(p)).join(" ")}`,
    ).catch(() => "");
    const hashes = out.trim() ? out.trim().split("\n") : [];
    existing.forEach((p, i) => {
      if (hashes[i]) {
        result.set(p, hashes[i].trim());
      }
    });
    return result;
  }

  /** Tracked paths with uncommitted working-tree changes (staged or unstaged) vs HEAD. */
  async getLocallyChangedPaths(): Promise<Set<string>> {
    const out = await this.execGit("diff --name-only HEAD").catch(() => "");
    return new Set(out.trim() ? out.trim().split("\n") : []);
  }

  private quoteArg(p: string): string {
    return `"${p.replace(/(["\\$`])/g, "\\$1")}"`;
  }

  /** Stage paths (handles new, modified and deleted files). */
  async stage(paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    await this.execGit(
      `add -- ${paths.map((p) => this.quoteArg(p)).join(" ")}`,
    );
  }

  /** Unstage paths (reset the index entry back to HEAD). */
  async unstage(paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    await this.execGit(
      `reset -q HEAD -- ${paths.map((p) => this.quoteArg(p)).join(" ")}`,
    );
  }

  getFileUri(ref: string, filePath: string): vscode.Uri {
    // Use git show to create a URI for the file at a specific ref
    return vscode.Uri.parse(
      `git-local-review://authority/${filePath}?ref=${encodeURIComponent(ref)}`,
    );
  }

  async getFileContent(ref: string, filePath: string): Promise<string> {
    try {
      return await this.execGit(`show ${ref}:${filePath}`);
    } catch {
      return "";
    }
  }

  // Reviewed snapshots are content-addressed files under the worktree's own
  // `.vscode/local-reviews/snapshots/<sha>`, NOT loose git objects. Worktrees share
  // one object store, so writing snapshots there both pollutes it and lets a stray
  // sha resolve to another worktree's blob; a per-worktree file store is isolated
  // and survives `git gc`.
  private get snapshotDir(): string {
    return path.join(
      this.workspaceRoot,
      ".vscode",
      "local-reviews",
      "snapshots",
    );
  }

  private snapshotPath(sha: string): string | undefined {
    // Guard the join: only a real 40-hex sha becomes a path.
    return /^[0-9a-f]{40}$/.test(sha)
      ? path.join(this.snapshotDir, sha)
      : undefined;
  }

  /** Persist `content` under its sha (idempotent — same sha ⇒ same content). */
  private async storeSnapshot(
    sha: string,
    content: string | Buffer,
  ): Promise<void> {
    const p = this.snapshotPath(sha);
    if (!p || fs.existsSync(p)) {
      return;
    }
    await fs.promises.mkdir(this.snapshotDir, { recursive: true });
    await fs.promises.writeFile(p, content);
  }

  /**
   * Snapshot the file's current working content and return its sha — the "last
   * reviewed" watermark. The sha is `hash-object` (no `-w`, so the shared object
   * store is untouched); the content lands in our per-worktree snapshot store.
   */
  async blessFile(filePath: string): Promise<string> {
    const abs = path.join(this.workspaceRoot, filePath);
    if (!fs.existsSync(abs)) {
      return "";
    }
    try {
      const sha = (
        await this.execGit(`hash-object -- ${this.quoteArg(filePath)}`)
      ).trim();
      if (sha) {
        await this.storeSnapshot(sha, await fs.promises.readFile(abs));
      }
      return sha;
    } catch {
      return "";
    }
  }

  /**
   * Content of a reviewed snapshot by sha (inverse of blessFile/writeBlob); '' if
   * gone. Reads the per-worktree store; a pre-hardening watermark that only exists in
   * the shared object store is read once via `cat-file` and migrated into the store
   * (so future reads are store-only and it survives gc). A sha in neither → '' (the
   * caller falls back to the base diff).
   */
  async getBlobContent(sha: string): Promise<string> {
    const p = this.snapshotPath(sha);
    if (p && fs.existsSync(p)) {
      try {
        return await fs.promises.readFile(p, "utf8");
      } catch {
        return "";
      }
    }
    try {
      const content = await this.execGit(`cat-file -p ${this.quoteArg(sha)}`);
      await this.storeSnapshot(sha, content);
      return content;
    } catch {
      return "";
    }
  }

  /** Whether a reviewed snapshot is retrievable — in our store, or (back-compat) the
   *  object store before it's been migrated/gc'd. */
  async blobExists(sha: string): Promise<boolean> {
    const p = this.snapshotPath(sha);
    if (p && fs.existsSync(p)) {
      return true;
    }
    return this.execGit(`cat-file -e ${this.quoteArg(sha)}`)
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Persist `content` as a reviewed snapshot and return its sha — used to advance a
   * snapshot by one hunk. `filePathForFilters` makes git apply the same gitattributes
   * (eol/clean) it would for that path when computing the sha, so it lines up with
   * `hashWorkingFiles`/`blessFile`. As with blessFile, `-w` is omitted: the content
   * goes to the per-worktree store, not the shared object database.
   */
  async writeBlob(
    content: string,
    filePathForFilters: string,
  ): Promise<string> {
    const tmp = path.join(
      os.tmpdir(),
      `lpr-blob-${process.pid}-${this.tmpCounter++}`,
    );
    await fs.promises.writeFile(tmp, content);
    try {
      const sha = (
        await this.execGit(
          `hash-object --path=${this.quoteArg(filePathForFilters)} -- ${this.quoteArg(tmp)}`,
        )
      ).trim();
      if (sha) {
        await this.storeSnapshot(sha, content);
      }
      return sha;
    } finally {
      fs.promises.unlink(tmp).catch(() => {
        /* best-effort */
      });
    }
  }

  /**
   * The change hunks between a reviewed-snapshot `baseContent` and the working file
   * — i.e. the parts not yet reviewed. `-U0` so each hunk is a minimal, precisely
   * spliceable region. Returns [] when the working file is gone or identical.
   */
  async getHunks(baseContent: string, filePath: string): Promise<DiffHunk[]> {
    const abs = path.join(this.workspaceRoot, filePath);
    if (!fs.existsSync(abs)) {
      return [];
    }
    const tmp = path.join(
      os.tmpdir(),
      `lpr-base-${process.pid}-${this.tmpCounter++}`,
    );
    await fs.promises.writeFile(tmp, baseContent);
    try {
      // --no-index diffs two files outside the index and exits 1 when they
      // differ, so swallow the exit code and parse stdout.
      const out = await this.execGitAllow(
        `diff --no-index --no-color -U0 -- ${this.quoteArg(tmp)} ${this.quoteArg(abs)}`,
      );
      return parseHunks(out);
    } finally {
      fs.promises.unlink(tmp).catch(() => {
        /* best-effort */
      });
    }
  }

  async getCommitsBetween(
    source: string,
    target: string,
  ): Promise<CommitInfo[]> {
    const SEP = "---SEP---";
    const format = `%H${SEP}%h${SEP}%s${SEP}%an${SEP}%aI${SEP}%ar`;
    try {
      const output = await this.execGit(
        `log --format="${format}" ${source}..${target}`,
      );
      if (!output.trim()) {
        return [];
      }
      return output
        .trim()
        .split("\n")
        .map((line) => {
          const [hash, shortHash, message, author, date, relativeDate] =
            line.split(SEP);
          return { hash, shortHash, message, author, date, relativeDate };
        });
    } catch {
      return [];
    }
  }

  private execGit(args: string): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.exec(
        `git ${args}`,
        { cwd: this.workspaceRoot, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
          } else {
            resolve(stdout);
          }
        },
      );
    });
  }

  /** Like execGit but resolves stdout regardless of exit code — for `git diff`,
   *  which exits non-zero merely because the inputs differ. */
  private execGitAllow(args: string): Promise<string> {
    return new Promise((resolve) => {
      cp.exec(
        `git ${args}`,
        { cwd: this.workspaceRoot, maxBuffer: 10 * 1024 * 1024 },
        (_error, stdout) => resolve(stdout || ""),
      );
    });
  }

  /** exec git, resolving stdout AND the exit code — `git merge-file` encodes the
   *  number of conflicts in its exit status, which we need to distinguish a clean
   *  merge from one that needs a reset. Never rejects. */
  private execGitWithCode(
    args: string,
  ): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve) => {
      cp.exec(
        `git ${args}`,
        { cwd: this.workspaceRoot, maxBuffer: 10 * 1024 * 1024 },
        (error: cp.ExecException | null, stdout) =>
          resolve({
            stdout: stdout || "",
            code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          }),
      );
    });
  }

  /**
   * Three-way merge of file content: replay the base→theirs change onto `ours`.
   * Used to rebase a reviewed snapshot when the review's merge-base advances, so
   * changes already in the (new) base branch stop showing as "to review". Returns
   * the merged content and whether it applied cleanly (clean=false means the base
   * edit and your reviewed edit overlap — the caller resets that file to the new base).
   */
  async threeWayMerge(
    ours: string,
    base: string,
    theirs: string,
  ): Promise<{ content: string; clean: boolean }> {
    const stamp = `${process.pid}-${this.tmpCounter++}`;
    const paths = {
      ours: path.join(os.tmpdir(), `lpr-merge-ours-${stamp}`),
      base: path.join(os.tmpdir(), `lpr-merge-base-${stamp}`),
      theirs: path.join(os.tmpdir(), `lpr-merge-theirs-${stamp}`),
    };
    await Promise.all([
      fs.promises.writeFile(paths.ours, ours),
      fs.promises.writeFile(paths.base, base),
      fs.promises.writeFile(paths.theirs, theirs),
    ]);
    try {
      const { stdout, code } = await this.execGitWithCode(
        `merge-file -p -q ${this.quoteArg(paths.ours)} ` +
          `${this.quoteArg(paths.base)} ${this.quoteArg(paths.theirs)}`,
      );
      return { content: stdout, clean: code === 0 };
    } finally {
      for (const p of Object.values(paths)) {
        fs.promises.unlink(p).catch(() => {
          /* best-effort */
        });
      }
    }
  }
}

/** Parse `git diff -U0` output into hunks (the `@@ -a,b +c,d @@` headers + the
 *  working-side `+` lines). A missing `,n` means a count of 1 (git's shorthand). */
function parseHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | undefined;
  for (const line of diff.split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur = {
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3], 10),
        newCount: m[4] !== undefined ? parseInt(m[4], 10) : 1,
        newLines: [],
      };
      hunks.push(cur);
    } else if (cur && line.startsWith("+") && !line.startsWith("+++")) {
      cur.newLines.push(line.slice(1));
    }
  }
  return hunks;
}
