import type { RoomSnapshot } from '$lib/protocol/client';
import { compareLogIds } from '$lib/protocol/reducer';
import type { Identity } from '$lib/protocol/types';
import { mentionsMe } from './messages';

/** How long the mention pulse stays on a row; the animation itself runs once. */
const PING_MS = 1200;

/**
 * Mentions of you as they arrive: the row pulses once, a room you aren't
 * reading gets an `@` badge (a thread's mentions badge both the thread and its
 * parent room), and
 * one that lands above the fold joins the jump bar's list. The first time a
 * room is seen its newest known log position becomes its watermark: messages
 * created at or below it are history (a thread's history loads only when it
 * is opened) and never ping; anything created after it is an arrival.
 */
export class MentionTracker {
	/** Message IDs pulsing because a mention of you just arrived. */
	pinged = $state<string[]>([]);
	/** Mentions that landed in a room or thread you weren't reading, cleared when you open it. */
	byRoom = $state<Record<string, number>>({});
	/** Mentions that arrived in the open pane while you were scrolled up, oldest first. */
	unseen = $state<string[]>([]);
	/** How many mentions of you have arrived so far: it ticks up once per new one. */
	arrived = $state(0);
	private readonly shown = new Map<string, Set<string>>();
	private readonly watermarks = new Map<string, string>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	/**
	 * Runs over every room after each snapshot; `pane` is the room (or thread)
	 * the viewer is reading, `latestVisible` whether its end is on screen.
	 */
	observe(rooms: RoomSnapshot[], me: Identity | undefined, pane: string | undefined, latestVisible: boolean): void {
		if (!me) return;
		const visible = new Set(rooms.map((room) => room.id));
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
			const badge = room.parentRoomId !== undefined && visible.has(room.parentRoomId) ? room.parentRoomId : room.id;
			for (const id of room.timeline.order) {
				if (shown.has(id)) continue;
				shown.add(id);
				if (watermark !== undefined && compareLogIds(id, watermark) <= 0) continue;
				const event = room.timeline.events[id];
				if (!event || !mentionsMe(event, me)) continue;
				this.ping(id);
				this.arrived++;
				if (room.id !== pane) {
					const next = { ...this.byRoom, [badge]: (this.byRoom[badge] ?? 0) + 1 };
					if (badge !== room.id) next[room.id] = (next[room.id] ?? 0) + 1;
					this.byRoom = next;
				}
				else if (!latestVisible) this.unseen = [...this.unseen, id];
			}
		}
	}

	clearRoom(roomId: string): void {
		if (!this.byRoom[roomId]) return;
		const next = { ...this.byRoom };
		delete next[roomId];
		this.byRoom = next;
	}

	clearUnseen(): void {
		if (this.unseen.length > 0) this.unseen = [];
	}

	/** The oldest mention still above the fold, taken off the list. */
	takeUnseen(): string | undefined {
		const [first, ...rest] = this.unseen;
		if (first) this.unseen = rest;
		return first;
	}

	dispose(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}

	/** One ring pulse on arrival, then the row settles back. */
	private ping(id: string): void {
		const running = this.timers.get(id);
		if (running) clearTimeout(running);
		else this.pinged = [...this.pinged, id];
		this.timers.set(id, setTimeout(() => {
			this.timers.delete(id);
			this.pinged = this.pinged.filter((pinged) => pinged !== id);
		}, PING_MS));
	}
}
