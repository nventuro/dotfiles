import * as vscode from 'vscode';
import * as fs from 'fs';

// GitHub-ish avatar palette; colour is picked deterministically from the name.
const PALETTE = [
    '#1f6feb', '#8957e5', '#238636', '#9e6a03',
    '#bc4c00', '#cf222e', '#0969da', '#57606a',
];

function hash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h;
}

function svgFor(name: string): string {
    const initial = (name.trim()[0] || '?').toUpperCase();
    const color = PALETTE[hash(name) % PALETTE.length];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
        `<circle cx="16" cy="16" r="16" fill="${color}"/>` +
        `<text x="16" y="21" text-anchor="middle" fill="#ffffff" ` +
        `font-family="-apple-system,Segoe UI,Ubuntu,sans-serif" font-size="15" font-weight="600">` +
        `${initial}</text></svg>`;
}

/**
 * Return a file Uri to a colored-initial avatar SVG for the given author,
 * generating and caching it under `dir` on first use. Best-effort: if the
 * file can't be written the Uri is still returned (renders as no avatar).
 */
export function getAvatarUri(dir: vscode.Uri, name: string): vscode.Uri {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'anon';
    const svg = svgFor(name);
    // Content-addressed filename: the tag changes whenever the SVG changes, so a
    // tweaked glyph regenerates instead of serving a stale cached avatar.
    const tag = hash(svg).toString(16);
    const fileUri = vscode.Uri.joinPath(dir, `avatar-${safe}-${tag}.svg`);
    try {
        fs.mkdirSync(dir.fsPath, { recursive: true });
        if (!fs.existsSync(fileUri.fsPath)) {
            fs.writeFileSync(fileUri.fsPath, svg, 'utf-8');
        }
    } catch {
        // best-effort
    }
    return fileUri;
}
