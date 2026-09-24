import type { RoomSnapshot } from '$lib/protocol/client';
import { compareLogIds } from '$lib/protocol/reducer';
import type { Identity } from '$lib/protocol/types';
import { isOwn } from './messages';

/**
 * Messages from others that arrived since the page loaded and you haven't
 * read yet, across every room and thread: what the tab title counts. As with
 * mentions, a room's newest known log position when it is first seen is its
 * watermark, so history never counts. An arrival stops counting once you
 * have had the end of its room on screen (in a visible tab), or once your
 * read cursor moves past it, from this connection or another device.
 */
export class UnreadTracker {
	/** Unread arrivals per room (threads are rooms of their own). */
	byRoom = $state<Record<string, number>>({});
	total = $derived(Object.values(this.byRoom).reduce((sum, count) => sum + count, 0));
	private readonly shown = new Map<string, Set<string>>();
	private readonly watermarks = new Map<string, string>();
	private readonly arrivals = new Map<string, string[]>();

	/**
	 * Runs over every room after each snapshot; `pane` is the room (or thread)
	 * the viewer is reading, `reading` whether its end is on screen in a visible tab.
	 */
	observe(rooms: RoomSnapshot[], me: Identity | undefined, pane: string | undefined, reading: boolean): void {
		if (!me) return;
		const next: Record<string, number> = {};
		for (const room of rooms) {
			let shown = this.shown.get(room.id);
			if (!shown) {
				shown = new Set<string>();
				this.shown.set(room.id, shown);
				const newest = [room.latestLogId, room.timeline.order[room.timeline.order.length - 1]]
					.filter((id): id is string => id !== undefined)
					.sort(compareLogIds)
					.pop();
				if (newest !== undefined) this.watermarks.set(room.id, newest);
			}
			const watermark = this.watermarks.get(room.id);
			let arrivals = this.arrivals.get(room.id) ?? [];
			for (const id of room.timeline.order) {
				if (shown.has(id)) continue;
				shown.add(id);
				if (watermark !== undefined && compareLogIds(id, watermark) <= 0) continue;
				const event = room.timeline.events[id];
				if (event && !isOwn(event, me)) arrivals.push(id);
			}
			const read = room.readMessageId;
			arrivals = room.id === pane && reading ? [] : arrivals.filter((id) => {
				const event = room.timeline.events[id];
				return event !== undefined && !event.deleted && (read === undefined || compareLogIds(id, read) > 0);
			});
			this.arrivals.set(room.id, arrivals);
			if (arrivals.length > 0) next[room.id] = arrivals.length;
		}
		if (!sameCounts(this.byRoom, next)) this.byRoom = next;
	}
}

function sameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
