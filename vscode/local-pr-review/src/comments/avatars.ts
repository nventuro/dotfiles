import * as vscode from 'vscode';
import * as fs from 'fs';
import * as https from 'https';

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

function svgFor(name: string, local: boolean): string {
    const initial = (name.trim()[0] || '?').toUpperCase();
    const color = PALETTE[hash(name) % PALETTE.length];
    // Bottom-right accent dot marks a 'local' comment (private to you + Claude, not
    // on GitHub). A plain dot reads at any size; the "local" text label carries the
    // meaning. White ring so it pops off any avatar colour.
    const badge = local
        ? '<circle cx="24.5" cy="24.5" r="4.9" fill="#15a3a3" stroke="#ffffff" stroke-width="1.35"/>'
        : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
        `<circle cx="16" cy="16" r="16" fill="${color}"/>` +
        `<text x="16" y="21" text-anchor="middle" fill="#ffffff" ` +
        `font-family="-apple-system,Segoe UI,Ubuntu,sans-serif" font-size="15" font-weight="600">` +
        `${initial}</text>${badge}</svg>`;
}

/**
 * Return a file Uri to a colored-initial avatar SVG for the given author,
 * generating and caching it under `dir` on first use. Best-effort: if the
 * file can't be written the Uri is still returned (renders as no avatar).
 */
export function getAvatarUri(dir: vscode.Uri, name: string, local = false): vscode.Uri {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'anon';
    const svg = svgFor(name, local);
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

/** Local cache path for a downloaded GitHub avatar (the image, not an initial). */
function githubAvatarFile(dir: vscode.Uri, name: string): vscode.Uri {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'anon';
    return vscode.Uri.joinPath(dir, `gh-${safe}.png`);
}

/**
 * Resolve the avatar Uri for a comment author. When the comment carries a
 * GitHub `avatarUrl` and we've already cached the downloaded image, use that;
 * otherwise fall back to the colored-initial SVG (which also covers the window
 * between a comment loading and `preloadAvatars` finishing its download).
 */
export function avatarFor(dir: vscode.Uri, name: string, avatarUrl?: string, local = false): vscode.Uri {
    if (avatarUrl) {
        const cached = githubAvatarFile(dir, name);
        if (fs.existsSync(cached.fsPath)) {
            return cached;
        }
    }
    return getAvatarUri(dir, name, local);
}

function download(url: string, dest: string, redirects = 3): Promise<void> {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'local-review' } }, res => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
                res.resume();
                download(res.headers.location, dest, redirects - 1).then(resolve, reject);
                return;
            }
            if (status !== 200) {
                res.resume();
                reject(new Error(`HTTP ${status}`));
                return;
            }
            const tmp = `${dest}.tmp`;
            const out = fs.createWriteStream(tmp);
            res.pipe(out);
            out.on('finish', () => out.close(() => {
                try { fs.renameSync(tmp, dest); resolve(); }
                catch (e) { reject(e); }
            }));
            out.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * Best-effort: download and cache any not-yet-cached GitHub avatars referenced
 * by these comments. Awaitable so callers can fetch before (re)rendering, but
 * every failure (offline, firewall-blocked CDN in a container) is swallowed —
 * the author just keeps the initial badge. Returns true if anything new landed.
 */
export async function preloadAvatars(
    dir: vscode.Uri,
    comments: { author: string; avatarUrl?: string }[]
): Promise<boolean> {
    const seen = new Set<string>();
    const jobs: Promise<boolean>[] = [];
    for (const c of comments) {
        if (!c.avatarUrl || seen.has(c.author)) { continue; }
        seen.add(c.author);
        const dest = githubAvatarFile(dir, c.author);
        if (fs.existsSync(dest.fsPath)) { continue; }
        jobs.push(
            (async () => {
                try {
                    fs.mkdirSync(dir.fsPath, { recursive: true });
                    await download(c.avatarUrl!, dest.fsPath);
                    return true;
                } catch {
                    return false;
                }
            })()
        );
    }
    const results = await Promise.all(jobs);
    return results.some(Boolean);
}
