import type { ChatClient } from '$lib/protocol/client';
import { rangeBetween, spanOf } from './messages';

/** Bulk select: the messages picked in one pane, and the move they are waiting on. */
export interface Selection {
	room: string;
	thread?: string;
	ids: string[];
	/** The last message picked, so a shift-click can fill the range to it. */
	last?: string;
	saving: boolean;
	/** Set after a move the server partly denied: the messages still picked. */
	denied?: { failed: number; total: number };
}

export type MoveResult = { moved: true; thread: string | null } | { moved: false; error: unknown };

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

	begin(room: string, thread: string | undefined, id: string): void {
		this.current = { room, thread, ids: [id], last: id, saving: false };
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
	 * One `message` request per picked message, all carrying the same thread
	 * (`null` moves them back to the room). Denied messages stay selected.
	 */
	async move(client: ChatClient, thread: string | null): Promise<MoveResult> {
		const current = this.current;
		if (!current || current.saving || current.ids.length === 0) return { moved: false, error: undefined };
		const ids = current.ids;
		this.current = { ...current, saving: true, denied: undefined };
		this.menuOpen = false;
		const results = await Promise.allSettled(ids.map((id) => client.setMessageThread(current.room, id, thread).promise));
		const failed = ids.filter((_, index) => results[index].status === 'rejected');
		if (failed.length === 0) {
			this.current = undefined;
			return { moved: true, thread };
		}
		const first = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
		this.current = { ...current, ids: failed, last: failed[failed.length - 1], saving: false, denied: { failed: failed.length, total: ids.length } };
		return { moved: false, error: first?.reason };
	}

	/** "New thread": one fresh thread for the whole selection, rooted at its earliest message in `order`. */
	async moveToNewThread(client: ChatClient, order: string[]): Promise<MoveResult> {
		const current = this.current;
		if (!current || current.saving || current.ids.length === 0) return { moved: false, error: undefined };
		const root = [...current.ids].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
		this.current = { ...current, saving: true, denied: undefined };
		this.menuOpen = false;
		try {
			const result = await client.createThread(current.room, { root_message_id: root }).promise;
			if (typeof result.thread_id !== 'string') throw new Error('Invalid thread response');
			this.current = { ...current, saving: false };
			return await this.move(client, result.thread_id);
		} catch (error) {
			this.current = { ...current, saving: false };
			return { moved: false, error };
		}
	}
}
