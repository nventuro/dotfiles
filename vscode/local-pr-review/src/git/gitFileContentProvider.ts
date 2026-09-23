import * as vscode from 'vscode';
import { GitService } from '../git/gitService';

/**
 * Provides file content from a specific git ref via a custom URI scheme.
 * URI format: git-local-review://authority/{filePath}?ref={branch}
 */
export class GitFileContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;
    // Resolves a file's CURRENT reviewed-snapshot content (set by extension.ts). The
    // `?snapshot=1` URI is stable per path; firing onDidChange on it (via refresh)
    // makes the quick-diff gutter recompute after a hunk is marked reviewed.
    private snapshotResolver: ((filePath: string) => Promise<string>) | undefined;

    constructor(private gitService: GitService) {}

    setSnapshotResolver(resolver: (filePath: string) => Promise<string>): void {
        this.snapshotResolver = resolver;
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
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

    /**
     * Invalidate VS Code's cached content for open virtual docs so they re-fetch.
     * The `:0` (index) ref is mutable — staging/unstaging changes it — but VS Code
     * caches provider output per URI until onDidChange fires, which otherwise left
     * an open diff showing stale (identical-to-working) content → "no diff".
     */
    refresh(): void {
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.uri.scheme === 'git-local-review') {
                this._onDidChange.fire(doc.uri);
            }
        }
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
