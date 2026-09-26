import { ApplyRequest, ReviewThread, ThreadStage } from './types';

/** The thread's stage, reading threads saved before stages existed by their `state`. */
export function stageOf(thread: ReviewThread): ThreadStage {
    return thread.stage ?? (thread.state === 'resolved' ? 'closed' : 'todo');
}

/** Move a thread to `stage`. Only a 'claude' thread keeps an apply request. */
export function moveThread(thread: ReviewThread, stage: ThreadStage, request?: ApplyRequest): void {
    thread.stage = stage;
    if (stage === 'claude' && request) {
        thread.request = request;
    } else {
        delete thread.request;
    }
    // Superseded by `stage`; left in place it would contradict it.
    delete thread.state;
    delete (thread as { disposition?: unknown }).disposition;
}

export const STAGE_LABEL: Record<ThreadStage, string> = {
    todo: 'To do',
    claude: 'With Claude',
    later: 'Later',
    closed: 'Closed',
};

/**
 * Why the thread is in its stage, shown next to the stage name: what brought a
 * To do or Later thread back to you, what Claude will do with a With Claude one,
 * and how a Closed one ended.
 */
export function stageTag(thread: ReviewThread): string {
    switch (stageOf(thread)) {
        case 'claude':
            return thread.request === 'apply-close' ? 'apply & close'
                : thread.request === 'apply' ? 'apply'
                : 'reply';
        case 'closed':
            return thread.applied ? 'applied' : 'discarded';
        default: {
            if (thread.applied) { return 'applied'; }
            const last = thread.comments[thread.comments.length - 1];
            return thread.comments.length > 1 && last?.author === 'claude'
                ? 'Claude replied'
                : 'new';
        }
    }
}
