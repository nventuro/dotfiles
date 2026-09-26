import * as vscode from 'vscode';
import { StorageService } from '../storage/storageService';
import { ReviewCommentController } from '../comments/commentController';
import { ApplyRequest, ReviewThread, ThreadStage } from '../types';
import { isOwnAuthor } from '../identity';
import { stageOf, stageTag } from '../stage';

interface ActionItem extends vscode.QuickPickItem {
    stage?: ThreadStage;
    request?: ApplyRequest;
    reply?: boolean;
}

async function revealThread(thread: ReviewThread, workspaceUri?: vscode.Uri): Promise<void> {
    if (!workspaceUri) { return; }
    const fileUri = vscode.Uri.joinPath(workspaceUri, thread.filePath);
    const pos = new vscode.Position(thread.startLine, 0);
    try {
        // preview:true reuses one tab across threads (no pile-up); preserveFocus
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
 * Walk the To do threads one at a time, revealing the code behind a QuickPick of
 * the actions a To do thread offers. Every choice moves the thread out of To do,
 * so the walk advances after each one; Esc exits.
 */
export async function runStepThrough(
    storageService: StorageService,
    commentController: ReviewCommentController,
    refreshViews: () => void,
    ownUser: string,
): Promise<void> {
    const comments = storageService.loadComments();
    // Snapshot the queue up front (same order as the Comments navigator). Each
    // thread is re-read before it's shown, in case something moved it meanwhile.
    const queue = (comments?.threads ?? [])
        .filter(t => stageOf(t) === 'todo')
        .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)
        .map(t => t.id);

    if (queue.length === 0) {
        vscode.window.showInformationMessage('Nothing to do 🎉');
        return;
    }

    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const total = queue.length;

    for (let i = 0; i < total; i++) {
        const threadId = queue[i];
        const thread = storageService.loadComments()?.threads.find(t => t.id === threadId);
        if (!thread || stageOf(thread) !== 'todo') { continue; }

        // Re-present this thread until an action is taken; a cancelled Reply…
        // comes back here.
        let done = false;
        while (!done) {
            await revealThread(thread, workspaceUri);

            const author = thread.comments[0]?.author ?? 'reviewer';
            const who = isOwnAuthor(author, ownUser) ? 'you' : author;
            const base = thread.filePath.substring(thread.filePath.lastIndexOf('/') + 1);
            const bodyPreview = (thread.comments[thread.comments.length - 1]?.body ?? '')
                .replace(/\s+/g, ' ').trim().slice(0, 120);

            const items: ActionItem[] = [
                {
                    label: '$(rocket) Apply & close',
                    description: 'Claude makes the change, then closes the thread',
                    detail: bodyPreview,
                    stage: 'claude',
                    request: 'apply-close',
                },
                {
                    label: '$(tools) Apply',
                    description: 'Claude makes the change, then sends it back to you',
                    stage: 'claude',
                    request: 'apply',
                },
                {
                    label: '$(comment) Reply…',
                    description: 'tell Claude what you want; it answers on the next /address-review',
                    reply: true,
                },
                {
                    label: '$(watch) Later',
                    description: 'set aside until the next /address-review',
                    stage: 'later',
                },
                {
                    label: '$(trash) Discard',
                    description: 'nothing more happens with it',
                    stage: 'closed',
                },
            ];

            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: `${base}:${thread.startLine + 1} · ${who} · ${stageTag(thread)} · ${i + 1}/${total}`,
                // Let you click into the editor to scroll the code, then return to
                // the still-open picker instead of it dismissing on focus loss.
                ignoreFocusOut: true,
            });

            if (!picked) { return; } // Esc — exit the walk

            if (picked.reply) {
                const text = await vscode.window.showInputBox({
                    prompt: 'Reply',
                    placeHolder: 'e.g. apply this, but use camelCase',
                    ignoreFocusOut: true,
                });
                if (text && text.trim()) {
                    commentController.replyToThreadById(threadId, text.trim());
                    done = true;
                }
            } else if (picked.stage) {
                commentController.moveThreadById(threadId, picked.stage, picked.request);
                done = true;
            }
            refreshViews();
        }
    }
}
