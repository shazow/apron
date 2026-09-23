import type { ChatClient } from '$lib/protocol/client';
import { rangeBetween, spanOf } from './messages';

/** Bulk select: the messages picked in one pane (a room or a thread, itself a room), and the move they are waiting on. */
export interface Selection {
	room: string;
	ids: string[];
	/** The last message picked, so a shift-click can fill the range to it. */
	last?: string;
	saving: boolean;
	/** Set after a move the server partly denied: the messages still picked. */
	denied?: { failed: number; total: number };
}

export type MoveResult = { moved: true; room: string } | { moved: false; error: unknown };

/** What a new thread from a selection is created with: its parent room and title (from the earliest message). */
export interface NewThreadOptions {
	parentRoomId: string;
	title: (introMessageId: string) => string;
}

/**
 * Select mode: entered with one message picked, grown by clicks and ranges,
 * and ended by a move or Cancel. Only IDs the caller offers can be picked; the
 * server still decides each move, and denied messages stay picked for a retry.
 */
export class MessageSelection {
	current = $state<Selection | undefined>();
	menuOpen = $state(false);
	readonly ids = $derived(this.current?.ids ?? []);
	readonly active = $derived(this.current !== undefined);

	has(id: string): boolean {
		return this.ids.includes(id);
	}

	begin(room: string, id: string): void {
		this.current = { room, ids: [id], last: id, saving: false };
	}

	/** Toggles one message, or with `range` fills from the last pick to it along `order`. */
	toggle(id: string, order: string[], range = false): void {
		const current = this.current;
		if (!current || current.saving) return;
		if (range && current.last) {
			this.current = { ...current, ids: rangeBetween(order, current.last, id), last: id, denied: undefined };
			return;
		}
		const picked = current.ids.includes(id);
		const ids = picked ? current.ids.filter((other) => other !== id) : [...current.ids, id];
		if (ids.length === 0) {
			this.cancel();
			return;
		}
		this.current = { ...current, ids, last: picked ? current.last : id, denied: undefined };
	}

	/** "Select between": fills the gap between the outermost messages already picked. */
	fillBetween(order: string[]): void {
		const current = this.current;
		if (!current || current.saving || current.ids.length < 2) return;
		this.current = { ...current, ids: spanOf(order, current.ids), denied: undefined };
	}

	cancel(): void {
		if (this.current?.saving) return;
		this.current = undefined;
		this.menuOpen = false;
	}

	/**
	 * One `message` save per picked message, each moving it to `room` (a
	 * thread, or a thread's parent room). Denied messages stay selected.
	 */
	async move(client: ChatClient, room: string): Promise<MoveResult> {
		const current = this.current;
		if (!current || current.saving || current.ids.length === 0) return { moved: false, error: undefined };
		const ids = current.ids;
		this.current = { ...current, saving: true, denied: undefined };
		this.menuOpen = false;
		const results = await Promise.allSettled(ids.map((id) => client.moveMessage(id, room).promise));
		const failed = ids.filter((_, index) => results[index].status === 'rejected');
		if (failed.length === 0) {
			this.current = undefined;
			return { moved: true, room };
		}
		const first = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
		this.current = { ...current, ids: failed, last: failed[failed.length - 1], saving: false, denied: { failed: failed.length, total: ids.length } };
		return { moved: false, error: first?.reason };
	}

	/**
	 * "New thread": one fresh thread for the whole selection, introduced by its
	 * earliest message in `order`. The thread is created first; the moves go
	 * out once the server has named it.
	 */
	async moveToNewThread(client: ChatClient, order: string[], options: NewThreadOptions): Promise<MoveResult> {
		const current = this.current;
		if (!current || current.saving || current.ids.length === 0) return { moved: false, error: undefined };
		const intro = [...current.ids].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
		this.current = { ...current, saving: true, denied: undefined };
		this.menuOpen = false;
		try {
			const result = await client.createRoom({ parentRoomId: options.parentRoomId, title: options.title(intro), introMessageId: intro }).promise;
			if (typeof result.room_id !== 'string') throw new Error('Invalid room response');
			this.current = { ...current, saving: false };
			return await this.move(client, result.room_id);
		} catch (error) {
			this.current = { ...current, saving: false };
			return { moved: false, error };
		}
	}
}
