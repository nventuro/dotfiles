import * as vscode from 'vscode';
import * as os from 'os';
import { StorageService } from '../storage/storageService';
import { ReviewThread, ThreadStage } from '../types';
import { isOwnAuthor, isOwnThread } from '../identity';
import { stageOf, stageTag, STAGE_LABEL } from '../stage';

/** The stage groups, in display order. Later and Closed hold nothing that needs
 *  you now, so they start collapsed; empty groups are omitted. */
const GROUPS: { stage: ThreadStage; expanded: boolean }[] = [
    { stage: 'todo', expanded: true },
    { stage: 'claude', expanded: true },
    { stage: 'later', expanded: false },
    { stage: 'closed', expanded: false },
];

/**
 * Navigator over the active review's comment threads: one row per thread
 * (`file:line — snippet`), grouped by stage, click to jump to the comment's location.
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

        // Bucket threads into groups, each kept in file→line order (same as Changed
        // Files). Iterating the pre-sorted list keeps every bucket sorted.
        const byStage = new Map<ThreadStage, CommentNavItem[]>();
        const sorted = [...comments.threads].sort((a, b) =>
            a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
        for (const t of sorted) {
            const stage = stageOf(t);
            const item = new CommentNavItem(
                t, ownUser, this.storageService.outdatedThreadIds.has(t.id));
            (byStage.get(stage) ?? byStage.set(stage, []).get(stage)!).push(item);
        }

        // Pinned step-through launcher on top (always visible, not hover-gated),
        // then the non-empty groups in display order.
        const out: vscode.TreeItem[] = [new StepThroughHeaderItem((byStage.get('todo') ?? []).length)];
        for (const g of GROUPS) {
            const children = byStage.get(g.stage);
            if (!children || children.length === 0) { continue; }
            out.push(new CommentGroupItem(g.stage, children, g.expanded));
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

const dim = new vscode.ThemeColor('descriptionForeground');

const STAGE_ICONS: Record<ThreadStage, vscode.ThemeIcon> = {
    // Your move — amber to stand out.
    todo: new vscode.ThemeIcon('person', new vscode.ThemeColor('localPrReview.unresolvedCommentForeground')),
    claude: new vscode.ThemeIcon('sparkle'),
    later: new vscode.ThemeIcon('watch', dim),
    closed: new vscode.ThemeIcon('archive', dim),
};

/** A closed row shows how it ended, with the icon of the action that closed it. */
function rowIcon(thread: ReviewThread): vscode.ThemeIcon {
    const stage = stageOf(thread);
    if (stage !== 'closed') { return STAGE_ICONS[stage]; }
    return new vscode.ThemeIcon(thread.applied ? 'tools' : 'trash', dim);
}

const STATUS_NOTE: Record<ThreadStage, string> = {
    todo: '  _(to do — your move)_',
    claude: '  _(with Claude — the next /address-review acts on it)_',
    later: '  _(later — back in To do after the next /address-review)_',
    closed: '  _(closed)_',
};

export class CommentNavItem extends vscode.TreeItem {
    // Exposed so the navigator's row actions can act by id — they work even for a
    // thread with no live inline instance (code committed away).
    readonly threadId: string;

    constructor(thread: ReviewThread, ownUser: string, outdated = false) {
        const base = thread.filePath.substring(thread.filePath.lastIndexOf('/') + 1);
        // Stored lines are 0-based (VS Code Range); show 1-based to the user.
        super(`${base}:${thread.startLine + 1}`, vscode.TreeItemCollapsibleState.None);
        this.threadId = thread.id;
        const stage = stageOf(thread);

        const author = thread.comments[0]?.author ?? '';
        const snippet = (thread.comments[0]?.body ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80);
        const replies = thread.comments.length > 1 ? ` +${thread.comments.length - 1}` : '';
        // Prefix the author for others' comments so "someone else's" reads at a glance.
        const who = isOwnThread(thread, ownUser) ? '' : `${author}: `;
        // Lead with the tag and the outdated marker rather than trailing them: the
        // description truncates from the right, so trailing markers are the first
        // thing cut off on a normal-width row.
        const prefix = (outdated && stage !== 'closed' ? 'outdated · ' : '') + `${stageTag(thread)} · `;
        this.description = prefix + who + snippet + replies;

        const tip = new vscode.MarkdownString(
            `**${thread.filePath}:${thread.startLine + 1}**` +
            STATUS_NOTE[stage] + '\n\n' +
            thread.comments.map(c => `**${isOwnAuthor(c.author, ownUser) ? 'you' : c.author}:** ${c.body}`).join('\n\n')
        );
        this.tooltip = tip;

        this.iconPath = rowIcon(thread);
        // Same tokens as the inline thread's contextValue, so rows offer the same
        // actions as the thread's header.
        this.contextValue = 'commentNav.' + (stage === 'claude' && thread.request
            ? `${stage}.${thread.request}`
            : stage);

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
 * A collapsible stage header grouping its threads, with the count in the
 * description. The stable `id` makes VS Code persist your expand/collapse across
 * refreshes — so the collapsed Later/Closed groups don't pop back open, and one
 * you've expanded isn't forced shut on the next comment change.
 */
export class CommentGroupItem extends vscode.TreeItem {
    constructor(
        stage: ThreadStage,
        public readonly children: CommentNavItem[],
        expanded: boolean
    ) {
        super(STAGE_LABEL[stage], expanded
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed);
        this.id = `commentGroup.${stage}`;
        this.description = `${children.length}`;
        this.contextValue = `commentGroup.${stage}`;
        this.iconPath = STAGE_ICONS[stage];
    }
}

/**
 * Always-visible top row of the Comments view that starts the step-through walk.
 * When threads are To do it's actionable (amber checklist + count, click →
 * picker); otherwise it's a quiet "nothing to do" status line.
 */
export class StepThroughHeaderItem extends vscode.TreeItem {
    constructor(todoCount: number) {
        super(todoCount > 0 ? 'Step through' : 'Nothing to do', vscode.TreeItemCollapsibleState.None);
        if (todoCount > 0) {
            this.description = `${todoCount} to do`;
            this.iconPath = new vscode.ThemeIcon(
                'checklist', new vscode.ThemeColor('localPrReview.unresolvedCommentForeground'));
            this.command = { command: 'localPrReview.stepThrough', title: 'Step through To do' };
            this.tooltip = 'Go through the To do threads one at a time';
        } else {
            this.iconPath = new vscode.ThemeIcon('check', dim);
            this.tooltip = 'No threads are waiting for you';
        }
        this.contextValue = 'commentNav.stepThroughHeader';
    }
}
