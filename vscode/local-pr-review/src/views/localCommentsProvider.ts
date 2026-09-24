import * as vscode from 'vscode';
import * as os from 'os';
import { StorageService } from '../storage/storageService';
import { ReviewThread } from '../types';
import { isOwnAuthor, isOwnThread } from '../identity';

/**
 * How a thread relates to you, which drives its icon and sort position:
 *  - 'needsOk'   someone else's comment (team/codex/GitHub), unresolved and not
 *                yet queued — awaiting your "Queue for apply". Sorted FIRST.
 *  - 'accepted'  someone else's comment you queued for apply — queued.
 *  - 'mine'      a comment you wrote (locally, or on the PR under your GitHub login).
 *  - 'muted'     someone else's comment you skipped-always — parked, out of triage.
 *  - 'resolved'  resolved — sorted last.
 */
type Category = 'needsOk' | 'accepted' | 'applied' | 'mine' | 'muted' | 'resolved';

/** The collapsible category groups, in display order. The "done" groups (muted,
 *  resolved) start collapsed so they're hidden until you want them; empty groups
 *  are omitted. Several categories fold into "Yours" so active work isn't
 *  fragmented across near-empty headers. */
interface GroupDef { key: string; label: string; cats: Category[]; expanded: boolean; }
const GROUPS: GroupDef[] = [
    { key: 'needsOk', label: 'Needs your OK', cats: ['needsOk'], expanded: true },
    { key: 'yours', label: 'Yours', cats: ['mine', 'accepted', 'applied'], expanded: true },
    { key: 'muted', label: 'Muted', cats: ['muted'], expanded: false },
    { key: 'resolved', label: 'Resolved', cats: ['resolved'], expanded: false },
];
const CAT_TO_GROUP = Object.fromEntries(
    GROUPS.flatMap(g => g.cats.map(c => [c, g.key]))
) as Record<Category, string>;

function categorize(thread: ReviewThread, ownUser: string, viewerLogin?: string): Category {
    if (thread.state === 'resolved') { return 'resolved'; }
    // Mute wins over ownership/applied, so muting a "yours" (or applied) thread
    // actually moves it into Muted — the navigator's Mute button relies on this.
    if (thread.disposition === 'dismissed') { return 'muted'; }
    if (isOwnThread(thread, ownUser, viewerLogin)) { return 'mine'; }
    if (thread.applied) { return 'applied'; }
    return thread.disposition === 'accepted' ? 'accepted' : 'needsOk';
}

/**
 * Navigator over the active review's comment threads: one row per thread
 * (`file:line — snippet`), click to jump to the comment's location.
 */
export class LocalCommentsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private storageService: StorageService) {}

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
        // A group's children are its threads (already file→line ordered below).
        if (element instanceof CommentGroupItem) {
            return element.children;
        }
        const comments = this.storageService.loadComments();
        if (!comments || comments.threads.length === 0) {
            return [];
        }
        const ownUser = os.userInfo().username;
        const viewerLogin = comments.viewerLogin;

        // Bucket threads into groups, each kept in file→line order (same as Changed
        // Files). Iterating the pre-sorted list keeps every bucket sorted.
        const byGroup = new Map<string, CommentNavItem[]>();
        const sorted = [...comments.threads]
            .map(t => ({ t, cat: categorize(t, ownUser, viewerLogin) }))
            .sort((a, b) =>
                a.t.filePath.localeCompare(b.t.filePath) || a.t.startLine - b.t.startLine);
        for (const { t, cat } of sorted) {
            const item = new CommentNavItem(
                t, cat, ownUser, this.storageService.outdatedThreadIds.has(t.id), viewerLogin);
            const gk = CAT_TO_GROUP[cat];
            (byGroup.get(gk) ?? byGroup.set(gk, []).get(gk)!).push(item);
        }

        // Pinned triage launcher on top (always visible, not hover-gated), then the
        // non-empty groups in display order.
        const needsOkCount = (byGroup.get('needsOk') ?? []).length;
        const out: vscode.TreeItem[] = [new TriageHeaderItem(needsOkCount)];
        for (const g of GROUPS) {
            const children = byGroup.get(g.key);
            if (!children || children.length === 0) { continue; }
            out.push(new CommentGroupItem(g.label, g.key, children, g.expanded));
        }
        return out;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

const ICONS: Record<Category, vscode.ThemeIcon> = {
    // Someone else's, awaiting you — amber person to stand out.
    needsOk: new vscode.ThemeIcon('person', new vscode.ThemeColor('localPrReview.unresolvedCommentForeground')),
    // You queued it — green rocket, echoing the "Queue for apply" action.
    accepted: new vscode.ThemeIcon('rocket', new vscode.ThemeColor('charts.green')),
    // The change was made; left for you to verify + resolve.
    applied: new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.blue')),
    // Your own note.
    mine: new vscode.ThemeIcon('comment'),
    // Skipped-always — parked, out of triage. Dimmed bell-slash.
    muted: new vscode.ThemeIcon('bell-slash', new vscode.ThemeColor('descriptionForeground')),
    // Done — dimmed check.
    resolved: new vscode.ThemeIcon('check', new vscode.ThemeColor('descriptionForeground')),
};

const GROUP_ICONS: Record<string, vscode.ThemeIcon> = {
    needsOk: new vscode.ThemeIcon('person', new vscode.ThemeColor('localPrReview.unresolvedCommentForeground')),
    yours: new vscode.ThemeIcon('comment'),
    muted: new vscode.ThemeIcon('bell-slash', new vscode.ThemeColor('descriptionForeground')),
    resolved: new vscode.ThemeIcon('check', new vscode.ThemeColor('descriptionForeground')),
};

const STATUS_NOTE: Record<Category, string> = {
    needsOk: '  _(needs your OK — “Queue for apply” on the comment, or run Triage)_',
    accepted: '  _(queued for /apply-review)_',
    applied: '  _(applied — verify, then resolve to close it on GitHub)_',
    mine: '',
    muted: '  _(skipped always — out of triage; untouched on GitHub. Restore on the comment)_',
    resolved: '  _(resolved)_',
};

export class CommentNavItem extends vscode.TreeItem {
    // Exposed so the navigator's Resolve/Reply/Unresolve commands can act by id —
    // they work even for a thread with no live inline instance (code committed away).
    readonly threadId: string;
    readonly isGithub: boolean;

    constructor(thread: ReviewThread, category: Category, ownUser: string, outdated = false, viewerLogin?: string) {
        const base = thread.filePath.substring(thread.filePath.lastIndexOf('/') + 1);
        // Stored lines are 0-based (VS Code Range); show 1-based to the user.
        super(`${base}:${thread.startLine + 1}`, vscode.TreeItemCollapsibleState.None);
        this.threadId = thread.id;
        this.isGithub = !!thread.github;

        const author = thread.comments[0]?.author ?? '';
        const snippet = (thread.comments[0]?.body ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80);
        const replies = thread.comments.length > 1 ? ` +${thread.comments.length - 1}` : '';
        // Prefix the author for others' comments so "someone else's" reads at a glance.
        const who = category === 'mine' ? '' : `${author}: `;
        // Lead with the outdated marker rather than trailing it: the description
        // truncates from the right, so a trailing "· outdated" was the first thing
        // cut off on a normal-width row. As a prefix it's always visible.
        const prefix = outdated && category !== 'resolved' ? 'outdated · ' : '';
        this.description = prefix + who + snippet + replies;

        const tip = new vscode.MarkdownString(
            `**${thread.filePath}:${thread.startLine + 1}**` +
            STATUS_NOTE[category] + '\n\n' +
            thread.comments.map(c => `**${isOwnAuthor(c.author, ownUser, viewerLogin) ? 'you' : c.author}:** ${c.body}`).join('\n\n')
        );
        this.tooltip = tip;

        this.iconPath = ICONS[category];
        this.contextValue = `commentNav.${category}`;

        // Open the comment in the diff for the current review mode (whole-branch or
        // uncommitted), not the bare file — so it's shown in context with the change.
        // Falls back to the plain file when the path isn't in the current change set.
        // A before-side comment is revealed on the left pane by its anchor code.
        this.command = {
            command: 'localPrReview.openCommentInDiff',
            title: 'Go to Comment',
            arguments: [{
                filePath: thread.filePath,
                startLine: thread.startLine,
                before: thread.onWorkingTree === false,
                anchor: thread.anchor?.code,
            }],
        };
    }
}

/**
 * A collapsible category header grouping its threads, with the count in the
 * description. The stable `id` makes VS Code persist your expand/collapse across
 * refreshes — so the collapsed Muted/Resolved groups don't pop back open, and one
 * you've expanded isn't forced shut on the next comment change.
 */
export class CommentGroupItem extends vscode.TreeItem {
    constructor(
        label: string,
        key: string,
        public readonly children: CommentNavItem[],
        expanded: boolean
    ) {
        super(label, expanded
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed);
        this.id = `commentGroup.${key}`;
        this.description = `${children.length}`;
        this.contextValue = `commentGroup.${key}`;
        this.iconPath = GROUP_ICONS[key];
    }
}

/**
 * Always-visible top row of the Comments view that acts as the Triage button.
 * When threads await your OK it's actionable (amber checklist + count, click →
 * picker); otherwise it's a quiet "all triaged" status line.
 */
export class TriageHeaderItem extends vscode.TreeItem {
    constructor(needsOkCount: number) {
        super(needsOkCount > 0 ? 'Triage' : 'All triaged', vscode.TreeItemCollapsibleState.None);
        if (needsOkCount > 0) {
            this.description = `${needsOkCount} need${needsOkCount === 1 ? 's' : ''} your OK`;
            this.iconPath = new vscode.ThemeIcon(
                'checklist', new vscode.ThemeColor('localPrReview.unresolvedCommentForeground'));
            this.command = { command: 'localPrReview.triage', title: 'Triage review comments' };
            this.tooltip = 'Start triage — step through each comment awaiting your OK';
        } else {
            this.description = 'nothing waiting';
            this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('descriptionForeground'));
            this.tooltip = 'No comments are waiting for your OK';
        }
        this.contextValue = 'commentNav.triageHeader';
    }
}
