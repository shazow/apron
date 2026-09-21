import type { RoomSnapshot } from '$lib/protocol/client';
import type { Identity } from '$lib/protocol/types';
import { mentionsMe } from './messages';

/** How long the mention pulse stays on a row; the animation itself runs once. */
const PING_MS = 1200;

/**
 * Mentions of you as they arrive: the row pulses once, a room you aren't
 * reading gets an `@` badge, and one that lands above the fold joins the jump
 * bar's list. Each room seeds silently the first time its timeline is seen, so
 * replayed history never pings; anything new after that is an arrival.
 */
export class MentionTracker {
	/** Message IDs pulsing because a mention of you just arrived. */
	pinged = $state<string[]>([]);
	/** Mentions that landed in a room you weren't reading, cleared when you open it. */
	byRoom = $state<Record<string, number>>({});
	/** Mentions that arrived in the open pane while you were scrolled up, oldest first. */
	unseen = $state<string[]>([]);
	private readonly shown = new Map<string, Set<string>>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	/** Runs over every room after each snapshot; `pane` is what the viewer is reading, `latestVisible` whether its end is on screen. */
	observe(rooms: RoomSnapshot[], me: Identity | undefined, pane: { room?: string; thread?: string }, latestVisible: boolean): void {
		if (!me) return;
		for (const room of rooms) {
			let shown = this.shown.get(room.id);
			const seeding = !shown;
			if (!shown) {
				shown = new Set<string>();
				this.shown.set(room.id, shown);
			}
			for (const id of room.timeline.order) {
				if (shown.has(id)) continue;
				shown.add(id);
				if (seeding) continue;
				const event = room.timeline.events[id];
				if (!event || !mentionsMe(event, me)) continue;
				this.ping(id);
				const here = room.id === pane.room && event.thread_id === pane.thread;
				if (!here) this.byRoom = { ...this.byRoom, [room.id]: (this.byRoom[room.id] ?? 0) + 1 };
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
