import type { OperationHandle } from '$lib/protocol/client';

export type Feedback = { kind: 'pending' | 'error'; text: string };

/** How long a request may take before the toast admits it is still pending. */
const QUIET_MS = 600;

/** The one toast at the foot of the pane: a pending line for slow requests, an error until the next one. */
export class FeedbackState {
	current = $state<Feedback | undefined>();
	private timer: ReturnType<typeof setTimeout> | undefined;

	pending(text: string): void {
		this.stopTimer();
		this.current = { kind: 'pending', text };
	}

	error(cause: unknown, fallback = 'Something went wrong'): void {
		this.stopTimer();
		this.current = { kind: 'error', text: cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : fallback };
	}

	clear(): void {
		this.stopTimer();
		this.current = undefined;
	}

	/** Shows the pending copy only when a request takes noticeably long, and its error until the next request. */
	track(handle: OperationHandle, pendingText: string, onError?: () => void): void {
		this.clear();
		this.timer = setTimeout(() => (this.current = { kind: 'pending', text: pendingText }), QUIET_MS);
		handle.promise
			.then(() => this.clear())
			.catch((cause: unknown) => {
				this.error(cause);
				onError?.();
			});
	}

	dispose(): void {
		this.stopTimer();
	}

	private stopTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
