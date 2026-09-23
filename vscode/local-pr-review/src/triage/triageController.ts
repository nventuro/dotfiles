import * as vscode from 'vscode';
import { StorageService } from '../storage/storageService';
import { ReviewCommentController } from '../comments/commentController';
import { ReviewThread } from '../types';
import { isOwnAuthor } from '../identity';

type Action = 'apply' | 'ignore' | 'resolveGithub' | 'mute' | 'reply' | 'skip';

interface ActionItem extends vscode.QuickPickItem {
    action: Action;
}

type ReviewAction = 'resolve' | 'reply' | 'skip';

interface ReviewActionItem extends vscode.QuickPickItem {
    action: ReviewAction;
}

/**
 * A thread that's awaiting your decision: someone else's (team/codex/GitHub),
 * unresolved, not already applied, not yet queued, and not skipped-always. Mirrors
 * the 'needsOk' category in localCommentsProvider so the triage queue matches the
 * navigator.
 */
function needsOk(thread: ReviewThread, ownUser: string, viewerLogin?: string): boolean {
    return thread.state !== 'resolved'
        && !isOwnAuthor(thread.comments[0]?.author ?? '', ownUser, viewerLogin)
        && !thread.applied
        && thread.disposition !== 'accepted'
        && thread.disposition !== 'dismissed';
}

async function revealThread(thread: ReviewThread, workspaceUri?: vscode.Uri): Promise<void> {
    if (!workspaceUri) { return; }
    const fileUri = vscode.Uri.joinPath(workspaceUri, thread.filePath);
    const pos = new vscode.Position(thread.startLine, 0);
    try {
        // preview:true reuses one tab across findings (no pile-up); preserveFocus
        // keeps focus off the editor so the picker shown next lands on top.
        await vscode.window.showTextDocument(fileUri, {
            selection: new vscode.Range(pos, pos),
            preview: true,
            preserveFocus: true,
        });
    } catch {
        // File may be gone (deleted change) — present the picker without a reveal.
    }
}

/**
 * Picker-primary triage: walk the "needs your OK" queue one finding at a time,
 * revealing the code behind a QuickPick whose default action is "Queue for apply"
 * (so a good suggestion is just Enter). Auto-advances after each decision; Esc
 * exits. Reproduces the per-finding picker flow, in-editor with code context.
 */
export async function runTriage(
    storageService: StorageService,
    commentController: ReviewCommentController,
    refreshViews: () => void,
    ownUser: string,
): Promise<void> {
    const comments = storageService.loadComments();
    if (!comments || comments.threads.length === 0) {
        vscode.window.showInformationMessage('Local Review: no comments to triage yet.');
        return;
    }
    const viewerLogin = comments.viewerLogin;

    // Snapshot the queue up front (same order as the Comments navigator). We
    // re-load each thread's current form before showing it, in case a prior
    // action moved it out of the queue.
    const queue = comments.threads
        .filter(t => needsOk(t, ownUser, viewerLogin))
        .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)
        .map(t => t.id);

    if (queue.length === 0) {
        vscode.window.showInformationMessage('Nothing to triage 🎉');
        return;
    }

    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const total = queue.length;

    for (let i = 0; i < total; i++) {
        const threadId = queue[i];
        let thread = storageService.loadComments()?.threads.find(t => t.id === threadId);
        if (!thread || !needsOk(thread, ownUser, viewerLogin)) { continue; }

        // Re-present THIS finding until a terminal action is taken. A posted Reply…
        // is terminal too (advances to the next finding); a cancelled Reply… re-presents.
        let done = false;
        while (!done && thread) {
            await revealThread(thread, workspaceUri);

            const isGithub = !!thread.github;
            const author = thread.comments[0]?.author ?? 'reviewer';
            const base = thread.filePath.substring(thread.filePath.lastIndexOf('/') + 1);
            const bodyPreview = (thread.comments[0]?.body ?? '')
                .replace(/\s+/g, ' ').trim().slice(0, 120);

            const items: ActionItem[] = [
                { label: '$(rocket) Queue for apply', detail: bodyPreview, action: 'apply' },
                isGithub
                    ? { label: '$(github-inverted) Resolve on GitHub', action: 'resolveGithub' }
                    : { label: '$(circle-slash) Ignore', action: 'ignore' },
                { label: '$(bell-slash) Skip always', detail: 'mute — out of triage, left open on GitHub', action: 'mute' },
                { label: '$(comment) Reply…', action: 'reply' },
                { label: '$(arrow-right) Skip for now', action: 'skip' },
            ];

            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: `${base}:${thread.startLine + 1} · ${author} · ${i + 1}/${total} — choose an action`,
                // Let you click into the editor to scroll the code, then return to
                // the still-open picker instead of it dismissing on focus loss.
                ignoreFocusOut: true,
            });

            if (!picked) { return; } // Esc — exit triage entirely

            switch (picked.action) {
                case 'apply':
                    commentController.queueThreadById(threadId);
                    done = true;
                    break;
                case 'ignore':
                    commentController.ignoreThreadById(threadId);
                    done = true;
                    break;
                case 'resolveGithub':
                    commentController.resolveThreadById(threadId);
                    done = true;
                    break;
                case 'mute':
                    commentController.muteThreadById(threadId);
                    done = true;
                    break;
                case 'reply': {
                    const text = await vscode.window.showInputBox({
                        prompt: 'Reply — private to you + Claude, never posted to GitHub',
                        placeHolder: 'e.g. apply this, but use camelCase',
                        ignoreFocusOut: true,
                    });
                    if (text && text.trim()) {
                        commentController.replyToThreadById(threadId, text.trim());
                        done = true; // posted — advance to the next finding
                    } else {
                        // Cancelled — stay on this finding.
                        thread = storageService.loadComments()?.threads.find(t => t.id === threadId);
                    }
                    break;
                }
                case 'skip':
                    done = true;
                    break;
            }
            refreshViews();
        }
    }
}

/**
 * Walk every OPEN (unresolved) comment one at a time — yours, queued, applied, or
 * awaiting-OK — revealing the code behind a QuickPick to Resolve / Reply / Skip.
 * Unlike runTriage (which only walks not-yours proposals to QUEUE them), this is the
 * "navigate and close out comments" loop. It acts by thread id, so it also reaches a
 * comment whose anchored code was committed/rebased away and has no inline widget.
 */
export async function runReview(
    storageService: StorageService,
    commentController: ReviewCommentController,
    refreshViews: () => void,
    ownUser: string,
): Promise<void> {
    const comments = storageService.loadComments();
    if (!comments || comments.threads.length === 0) {
        vscode.window.showInformationMessage('Local Review: no comments yet.');
        return;
    }
    const viewerLogin = comments.viewerLogin;

    const queue = comments.threads
        .filter(t => t.state !== 'resolved')
        .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)
        .map(t => t.id);

    if (queue.length === 0) {
        vscode.window.showInformationMessage('No open comments — all resolved 🎉');
        return;
    }

    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const total = queue.length;

    for (let i = 0; i < total; i++) {
        const threadId = queue[i];
        let thread = storageService.loadComments()?.threads.find(t => t.id === threadId);
        if (!thread || thread.state === 'resolved') { continue; }

        let done = false;
        while (!done && thread) {
            await revealThread(thread, workspaceUri);

            const author = thread.comments[0]?.author ?? 'reviewer';
            const who = isOwnAuthor(author, ownUser, viewerLogin) ? 'you' : author;
            const base = thread.filePath.substring(thread.filePath.lastIndexOf('/') + 1);
            const bodyPreview = (thread.comments[0]?.body ?? '')
                .replace(/\s+/g, ' ').trim().slice(0, 120);

            const items: ReviewActionItem[] = [
                { label: '$(check) Resolve', detail: bodyPreview, action: 'resolve' },
                { label: '$(comment) Reply…', action: 'reply' },
                { label: '$(arrow-right) Skip for now', action: 'skip' },
            ];

            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: `${base}:${thread.startLine + 1} · ${who} · ${i + 1}/${total} — resolve, reply, or skip`,
                ignoreFocusOut: true,
            });

            if (!picked) { return; } // Esc — exit the walk

            switch (picked.action) {
                case 'resolve':
                    commentController.resolveThreadById(threadId);
                    done = true;
                    break;
                case 'reply': {
                    const text = await vscode.window.showInputBox({
                        prompt: 'Reply — private to you + Claude, never posted to GitHub',
                        placeHolder: 'e.g. done, or: actually also rename the helper',
                        ignoreFocusOut: true,
                    });
                    if (text && text.trim()) {
                        commentController.replyToThreadById(threadId, text.trim());
                        done = true; // posted — advance to the next comment
                    } else {
                        thread = storageService.loadComments()?.threads.find(t => t.id === threadId);
                    }
                    break;
                }
                case 'skip':
                    done = true;
                    break;
            }
            refreshViews();
        }
    }
}
