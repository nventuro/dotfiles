import * as vscode from 'vscode';
import { GitService } from '../git/gitService';

/**
 * Provides file content from a specific git ref via a custom URI scheme.
 * URI format: git-local-review://authority/{filePath}?ref={branch}
 *
 * Served as a read-only file system rather than a TextDocumentContentProvider:
 * VS Code can leave a content-provider document it released and re-acquired in
 * one go (as the quick diff does with the `?snapshot=1` original) permanently
 * unopenable — "Cannot add model because it already exists" — until the window
 * reloads. File-system documents don't have that failure mode.
 */
export class GitFileContentProvider implements vscode.FileSystemProvider {
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;
    // Resolves a file's CURRENT reviewed-snapshot content (set by extension.ts). The
    // `?snapshot=1` URI is stable per path; firing a change on it (via refresh)
    // makes the quick-diff gutter recompute after a hunk is marked reviewed.
    private snapshotResolver: ((filePath: string) => Promise<string>) | undefined;
    // Reported as every file's mtime and bumped by refresh: VS Code skips re-reading
    // a changed file whose mtime and size are both unchanged, which an edit that
    // keeps the length would otherwise hit.
    private mtime = Date.now();

    constructor(private gitService: GitService) {}

    setSnapshotResolver(resolver: (filePath: string) => Promise<string>): void {
        this.snapshotResolver = resolver;
    }

    private async readContent(uri: vscode.Uri): Promise<string> {
        const filePath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
        const params = new URLSearchParams(uri.query);

        // `?snapshot=1`: the file's live reviewed snapshot R (quick-diff original side).
        if (params.get('snapshot') && this.snapshotResolver) {
            return this.snapshotResolver(filePath);
        }

        // A `?blob=<sha>` URI serves a content-addressed blob directly (a reviewed
        // snapshot), independent of any path — used as the left side of the side-by-
        // side review diff.
        const blob = params.get('blob');
        if (blob) {
            return this.gitService.getBlobContent(blob);
        }

        const ref = params.get('ref');
        if (!ref) {
            return '';
        }

        return this.gitService.getFileContent(ref, filePath);
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        return Buffer.from(await this.readContent(uri), 'utf8');
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        return {
            type: vscode.FileType.File,
            ctime: 0,
            mtime: this.mtime,
            size: (await this.readFile(uri)).byteLength,
        };
    }

    watch(): vscode.Disposable {
        // Changes are pushed by refresh; there is nothing to watch.
        return new vscode.Disposable(() => {});
    }

    readDirectory(): [string, vscode.FileType][] {
        throw vscode.FileSystemError.NoPermissions();
    }

    createDirectory(): void {
        throw vscode.FileSystemError.NoPermissions();
    }

    writeFile(): void {
        throw vscode.FileSystemError.NoPermissions();
    }

    delete(): void {
        throw vscode.FileSystemError.NoPermissions();
    }

    rename(): void {
        throw vscode.FileSystemError.NoPermissions();
    }

    /**
     * Invalidate VS Code's cached content for open virtual docs so they re-fetch.
     * The `:0` (index) ref is mutable — staging/unstaging changes it — but VS Code
     * caches file content per URI until a change event fires, which otherwise left
     * an open diff showing stale (identical-to-working) content → "no diff".
     */
    refresh(): void {
        this.mtime++;
        const changes: vscode.FileChangeEvent[] = [];
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.uri.scheme === 'git-local-review') {
                changes.push({ type: vscode.FileChangeType.Changed, uri: doc.uri });
            }
        }
        if (changes.length > 0) {
            this._onDidChangeFile.fire(changes);
        }
    }

    dispose(): void {
        this._onDidChangeFile.dispose();
    }
}
