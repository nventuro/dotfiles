import { ReviewThread } from './types';

/**
 * Whether `author` is you. Two identities count as "you":
 *   - your OS username — how local comments (yours / via the picker) are authored;
 *   - your GitHub login — how comments you wrote on the PR are authored, recorded
 *     as `CommentsFile.viewerLogin` when a PR's comments are imported.
 * Without this, a note you left on your own PR loads under your GitHub login (≠ OS
 * username) and gets mis-filed as "someone else's, awaiting your OK" in triage.
 */
export function isOwnAuthor(author: string, osUser: string, viewerLogin?: string): boolean {
    if (!author) { return false; }
    if (author === osUser) { return true; }
    return !!viewerLogin && author === viewerLogin;
}

/** Whether the thread's head comment is yours (drives "mine" categorization). */
export function isOwnThread(thread: ReviewThread, osUser: string, viewerLogin?: string): boolean {
    return isOwnAuthor(thread.comments[0]?.author ?? '', osUser, viewerLogin);
}
