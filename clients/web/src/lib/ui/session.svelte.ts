import { canEdit, canManageRooms, canReact, capabilitiesOf, type ChatClient, type ClientSnapshot, type RoomSnapshot } from '$lib/protocol/client';
import type { Identity, ServerParams } from '$lib/protocol/types';
import { connectionStateOf, isSessionReady, reconnectErrorOf } from './connection';

type HeldSession = { rooms: RoomSnapshot[]; activeRoom?: string; you?: Identity; server?: ServerParams };

/** How long a reconnect may run quietly before the UI escalates and offers a manual retry. */
export const RECONNECT_STALL_MS = 10_000;

export const blankSnapshot = (): ClientSnapshot => ({
	status: 'idle', authenticated: false, capabilities: capabilitiesOf(undefined), rooms: [], pending: [], typing: [], showReconnectDivider: false
});

/**
 * The page's view of the protocol client. The client rebuilds its rooms and
 * identity from each new connection, so while a reconnect is in flight (and
 * until the fresh rooms have arrived) this keeps showing the last authenticated
 * view instead of collapsing to an empty shell, and re-selects the room the
 * viewer was in once the reconnected server announces it.
 */
export class SessionView {
	// Snapshots are immutable values from the client: raw state avoids proxying them and keeps identity comparisons honest.
	snapshot = $state.raw<ClientSnapshot>(blankSnapshot());
	/** True once a dropped connection has stayed down for RECONNECT_STALL_MS. */
	stalled = $state(false);
	private held = $state.raw<HeldSession | undefined>();
	private pendingActiveRoom: string | undefined;
	private stallTimer: ReturnType<typeof setTimeout> | undefined;

	readonly ready = $derived(isSessionReady(this.snapshot));
	readonly connection = $derived(connectionStateOf(this.snapshot));
	readonly reconnectError = $derived(reconnectErrorOf(this.snapshot));
	/** A reconnect that has stalled past the quiet window, or one the server refused. */
	readonly reconnectNeedsAttention = $derived(this.connection === 'reconnecting' && (this.stalled || Boolean(this.reconnectError)));
	private readonly holding = $derived(Boolean(this.held) && (!this.ready || this.snapshot.rooms.length === 0) && this.snapshot.status !== 'offline');
	readonly rooms = $derived(this.snapshot.rooms.length ? this.snapshot.rooms : this.holding ? this.held!.rooms : []);
	readonly activeRoomId = $derived(this.snapshot.rooms.length ? this.snapshot.activeRoom : this.holding ? this.held!.activeRoom : undefined);
	readonly you = $derived(this.snapshot.you ?? (this.holding ? this.held!.you : undefined));
	readonly server = $derived(this.snapshot.server ?? (this.holding ? this.held!.server : undefined));
	readonly activeRoom = $derived.by(() => {
		const live = this.rooms.find((room) => room.id === this.activeRoomId);
		// A freshly announced room starts empty while history recovers; keep the
		// held copy on screen until the recovered timeline replaces it.
		const held = this.held;
		if (live && held && live !== held.rooms.find((room) => room.id === live.id) && live.recovering && live.timeline.order.length === 0) {
			return held.rooms.find((room) => room.id === live.id) ?? live;
		}
		return live;
	});
	/** Edit, move, and delete (cap `edit`). */
	readonly canEdit = $derived(canEdit(this.server));
	/** Create and update rooms and threads (cap `rooms`). */
	readonly canManageRooms = $derived(canManageRooms(this.server));
	/** Reaction chips and the React action (cap `reactions`). */
	readonly canReact = $derived(canReact(this.server));
	/** Attachments need cap `embed:upload` (Appendix E), which this client does not implement yet. */
	readonly canUpload = false;

	/** Takes the client's next snapshot and keeps the held view in step with it. */
	apply(next: ClientSnapshot, client: ChatClient): void {
		this.snapshot = next;
		if (next.status === 'offline') {
			this.held = undefined;
		} else if (isSessionReady(next) && next.disconnectedAt === undefined && next.rooms.length > 0
			&& !next.rooms.some((room) => room.recovering && room.timeline.order.length === 0)) {
			this.held = { rooms: next.rooms, activeRoom: next.activeRoom, you: next.you, server: next.server };
		}
		if (next.disconnectedAt !== undefined && this.held) this.pendingActiveRoom = this.held.activeRoom;
		const target = this.pendingActiveRoom;
		if (target && isSessionReady(next) && next.rooms.some((room) => room.id === target)) {
			this.pendingActiveRoom = undefined;
			if (next.activeRoom !== target) client.selectRoom(target);
		}
		this.trackStall(next);
	}

	/** Selects a room, remembering it for the reconnect if the server is currently away. */
	chooseRoom(client: ChatClient, roomId: string): void {
		client.selectRoom(roomId);
		if (this.holding && this.held) this.held = { ...this.held, activeRoom: roomId };
		this.pendingActiveRoom = this.holding ? roomId : undefined;
	}

	/** Drops the held view: the next connection is a different session (a new server, or a sign-out). */
	forget(): void {
		this.held = undefined;
		this.pendingActiveRoom = undefined;
	}

	retryNow(client: ChatClient): void {
		this.stalled = false;
		client.retryNow();
	}

	dispose(): void {
		if (this.stallTimer) clearTimeout(this.stallTimer);
	}

	private trackStall(next: ClientSnapshot): void {
		if (this.stallTimer) clearTimeout(this.stallTimer);
		this.stallTimer = undefined;
		const since = next.disconnectedAt;
		if (since === undefined || isSessionReady(next)) {
			this.stalled = false;
			return;
		}
		const remaining = RECONNECT_STALL_MS - (Date.now() - since);
		if (remaining <= 0) {
			this.stalled = true;
			return;
		}
		this.stallTimer = setTimeout(() => (this.stalled = true), remaining);
	}
}
