import { ReviewThread } from './types';

/** Whether `author` is you: local comments are authored by your OS username. */
export function isOwnAuthor(author: string, osUser: string): boolean {
    return !!author && author === osUser;
}

/** Whether the thread's head comment is yours (drives "mine" categorization). */
export function isOwnThread(thread: ReviewThread, osUser: string): boolean {
    return isOwnAuthor(thread.comments[0]?.author ?? '', osUser);
}
