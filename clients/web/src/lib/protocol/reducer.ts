import {
	decodeMessage,
	decodeReactions,
	decodeRoom,
	isJsonObject,
	type Identity,
	type MessageRecord,
	type ReactionSet,
	type RoomRecord
} from './types';

/**
 * Messages currently homed in one room, in numeric `message_id` order, with
 * their aggregated reactions. Instances are immutable: the client publishes a
 * new object whenever the room's messages or reactions change.
 */
export interface TimelineState {
	room: string;
	/** Latest snapshot per `message_id`, only for messages whose `room_id` is this room. */
	events: Readonly<Record<string, MessageRecord>>;
	/** `message_id`s in ascending numeric order. */
	order: readonly string[];
	/**
	 * Aggregated reactions per `message_id`, present only for messages that are
	 * not tombstones and have at least one non-empty set (§4.5).
	 */
	reactions: Readonly<Record<string, ReactionSummary[]>>;
}

/** One emoji on one message, aggregated across every user's set. */
export interface ReactionSummary {
	emoji: string;
	count: number;
	/** Sorted by string order. */
	user_ids: string[];
	/** Identities as last seen in each user's reaction set, in `user_ids` order. */
	users: Identity[];
	/** Whether the viewing user's own set contains the emoji. */
	mine: boolean;
}

export function createTimeline(room: string): TimelineState {
	return { room, events: Object.create(null), order: [], reactions: Object.create(null) };
}

export function timelineEvents(state: TimelineState): MessageRecord[] {
	return state.order.map((id) => state.events[id]);
}

/** Numeric comparison of positive decimal IDs (`"9" < "10"`). */
export function compareLogIds(a: string, b: string): number {
	if (a.length !== b.length) return a.length < b.length ? -1 : 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Unicode code point order, as the reaction projection requires (not UTF-16 unit order). */
export function compareCodePoints(a: string, b: string): number {
	const left = [...a], right = [...b];
	for (let index = 0; index < Math.min(left.length, right.length); index++) {
		const difference = left[index].codePointAt(0)! - right[index].codePointAt(0)!;
		if (difference !== 0) return difference < 0 ? -1 : 1;
	}
	return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** A room record that changed the room's title (`''` when cleared), at that record's `log_id`. */
export interface RoomRename {
	log_id: string;
	title: string;
	previous: string;
}

/**
 * The client-side record stores (PROTOCOL.md §2): one room record per
 * `room_id`, one message snapshot per `message_id`, one reaction set per
 * `(message_id, user_id)`. Every record replaces the stored one only when its
 * `log_id` is numerically greater, regardless of source or arrival order; a
 * room record without `log_id` (a server without cap `history`) always
 * replaces. Messages are indexed by their current `room_id`, so a move
 * snapshot re-homes a message instead of duplicating it.
 *
 * Every mutating call records the rooms whose projection changed; callers
 * drain them with `takeTouched()`.
 */
export class ProtocolStore {
	private readonly roomRecords = new Map<string, RoomRecord>();
	/** Every logged room record's title by `log_id`, per room, superseded or not: what renames are read from. */
	private readonly roomTitles = new Map<string, Map<string, string>>();
	private readonly messageRecords = new Map<string, MessageRecord>();
	private readonly reactionSets = new Map<string, Map<string, ReactionSet>>();
	private readonly homes = new Map<string, Set<string>>();
	private touched = new Set<string>();

	room(roomId: string): RoomRecord | undefined {
		return this.roomRecords.get(roomId);
	}

	message(messageId: string): MessageRecord | undefined {
		return this.messageRecords.get(messageId);
	}

	/** Every room that has a stored record or at least one message homed in it. */
	roomIds(): string[] {
		const ids = new Set(this.roomRecords.keys());
		for (const [roomId, messages] of this.homes) if (messages.size) ids.add(roomId);
		return [...ids];
	}

	/** `message_id`s currently homed in the room, ascending numerically. */
	messageIdsIn(roomId: string): string[] {
		return [...(this.homes.get(roomId) ?? [])].sort(compareLogIds);
	}

	messagesIn(roomId: string): MessageRecord[] {
		return this.messageIdsIn(roomId).map((id) => this.messageRecords.get(id)!);
	}

	/** The stored set for one user on one message, if any. */
	reactionSet(messageId: string, userId: string): ReactionSet | undefined {
		return this.reactionSets.get(messageId)?.get(userId);
	}

	/**
	 * Aggregated reactions for a message: undefined for tombstones, for
	 * messages without a non-empty set, and (by default) for messages that are
	 * not loaded. Emoji sort in code point order; users in string order.
	 */
	reactions(messageId: string, you?: string): ReactionSummary[] | undefined {
		const message = this.messageRecords.get(messageId);
		if (!message || message.deleted === true) return undefined;
		const sets = this.reactionSets.get(messageId);
		if (!sets) return undefined;
		const byEmoji = new Map<string, Map<string, Identity>>();
		for (const set of sets.values()) {
			for (const emoji of set.emojis) {
				let users = byEmoji.get(emoji);
				if (!users) byEmoji.set(emoji, (users = new Map()));
				users.set(set.from.user_id, set.from);
			}
		}
		if (!byEmoji.size) return undefined;
		return [...byEmoji.keys()].sort(compareCodePoints).map((emoji) => {
			const users = byEmoji.get(emoji)!;
			const userIds = [...users.keys()].sort(compareStrings);
			return {
				emoji,
				count: userIds.length,
				user_ids: userIds,
				users: userIds.map((id) => users.get(id)!),
				mine: you !== undefined && users.has(you)
			};
		});
	}

	/** Install a room record by the replay rule. Returns whether it replaced the stored one. */
	putRoom(record: RoomRecord): boolean {
		if (record.log_id !== undefined) {
			let titles = this.roomTitles.get(record.room_id);
			if (!titles) this.roomTitles.set(record.room_id, (titles = new Map()));
			if (!titles.has(record.log_id)) {
				titles.set(record.log_id, record.title ?? '');
				this.touched.add(record.room_id);
			}
		}
		const current = this.roomRecords.get(record.room_id);
		if (current && record.log_id !== undefined && current.log_id !== undefined && compareLogIds(record.log_id, current.log_id) <= 0) {
			return false;
		}
		this.roomRecords.set(record.room_id, record);
		this.touched.add(record.room_id);
		return true;
	}

	/**
	 * The room's title changes, ascending: each logged room record whose title
	 * differs from the record just before it among those seen. History
	 * compaction may drop records, so a rename between two unseen ones is missed.
	 */
	roomRenames(roomId: string): RoomRename[] {
		const titles = [...(this.roomTitles.get(roomId) ?? [])].sort(([a], [b]) => compareLogIds(a, b));
		const renames: RoomRename[] = [];
		for (let index = 1; index < titles.length; index++) {
			const [logId, title] = titles[index];
			if (title !== titles[index - 1][1]) renames.push({ log_id: logId, title, previous: titles[index - 1][1] });
		}
		return renames;
	}

	/** Install a message snapshot by the replay rule, re-homing it on a move. */
	putMessage(record: MessageRecord): boolean {
		const current = this.messageRecords.get(record.message_id);
		if (current && compareLogIds(record.log_id, current.log_id) <= 0) return false;
		if (current && current.room_id !== record.room_id) {
			this.unhome(current.room_id, current.message_id);
		}
		this.messageRecords.set(record.message_id, record);
		this.home(record.room_id, record.message_id);
		return true;
	}

	/** Install one user's reaction set by the replay rule. */
	putReaction(set: ReactionSet): boolean {
		let sets = this.reactionSets.get(set.message_id);
		const current = sets?.get(set.from.user_id);
		if (current && compareLogIds(set.log_id, current.log_id) <= 0) return false;
		if (!sets) this.reactionSets.set(set.message_id, (sets = new Map()));
		sets.set(set.from.user_id, set);
		const home = this.messageRecords.get(set.message_id)?.room_id;
		if (home !== undefined) this.touched.add(home);
		return true;
	}

	/** Drop the room's messages whose latest snapshot is below `floor` (retention eviction). */
	evictBefore(roomId: string, floor: string): void {
		for (const id of [...(this.homes.get(roomId) ?? [])]) {
			const message = this.messageRecords.get(id)!;
			if (compareLogIds(message.log_id, floor) >= 0) continue;
			this.messageRecords.delete(id);
			this.unhome(roomId, id);
		}
	}

	/**
	 * Clear a room's messages and their reaction sets (a history rebuild), and
	 * reaction sets logged in the room for messages that are not loaded.
	 */
	clearRoom(roomId: string): void {
		for (const id of [...(this.homes.get(roomId) ?? [])]) {
			this.messageRecords.delete(id);
			this.reactionSets.delete(id);
			this.unhome(roomId, id);
		}
		for (const [messageId, sets] of this.reactionSets) {
			if (this.messageRecords.has(messageId)) continue;
			for (const [userId, set] of sets) if (set.room_id === roomId) sets.delete(userId);
			if (!sets.size) this.reactionSets.delete(messageId);
		}
		this.touched.add(roomId);
	}

	clear(): void {
		for (const roomId of this.roomIds()) this.touched.add(roomId);
		this.roomRecords.clear();
		this.roomTitles.clear();
		this.messageRecords.clear();
		this.reactionSets.clear();
		this.homes.clear();
	}

	/** Rooms whose projection changed since the last call. */
	takeTouched(): Set<string> {
		const touched = this.touched;
		this.touched = new Set();
		return touched;
	}

	/** Build the immutable timeline of one room. */
	timeline(roomId: string, you?: string): TimelineState {
		const events: Record<string, MessageRecord> = Object.create(null);
		const reactions: Record<string, ReactionSummary[]> = Object.create(null);
		const order = this.messageIdsIn(roomId);
		for (const id of order) {
			events[id] = this.messageRecords.get(id)!;
			const summary = this.reactions(id, you);
			if (summary) reactions[id] = summary;
		}
		return { room: roomId, events, order, reactions };
	}

	private home(roomId: string, messageId: string): void {
		let messages = this.homes.get(roomId);
		if (!messages) this.homes.set(roomId, (messages = new Set()));
		messages.add(messageId);
		this.touched.add(roomId);
	}

	private unhome(roomId: string, messageId: string): void {
		const messages = this.homes.get(roomId);
		if (!messages) return;
		messages.delete(messageId);
		if (!messages.size) this.homes.delete(roomId);
		this.touched.add(roomId);
	}
}

/** Records decoded from one frame or history result, partitioned by kind. */
export interface DecodedRecords {
	rooms: RoomRecord[];
	messages: MessageRecord[];
	reactions: ReactionSet[];
	/** Embedded snapshots (`reply_to`, `intro_message`), each belonging to its own `room_id`. */
	embedded: MessageRecord[];
}

/**
 * Decode every record in a history result (§4.1): room records, message
 * snapshots, reaction sets, and embedded snapshots. Records are not filtered by
 * the requested room: a move snapshot carries its destination `room_id`.
 */
export function decodeHistoryRecords(result: unknown): DecodedRecords {
	const decoded: DecodedRecords = { rooms: [], messages: [], reactions: [], embedded: [] };
	if (!isJsonObject(result)) return decoded;
	for (const value of Array.isArray(result.rooms) ? result.rooms : []) {
		const room = decodeRoom(value);
		if (!room) continue;
		decoded.rooms.push(room.record);
		decoded.embedded.push(...room.embedded);
	}
	for (const value of Array.isArray(result.entries) ? result.entries : []) {
		const message = decodeMessage(value);
		if (!message) continue;
		decoded.messages.push(message.record);
		decoded.embedded.push(...message.embedded);
	}
	for (const value of Array.isArray(result.reactions) ? result.reactions : []) {
		decoded.reactions.push(...decodeReactions(value));
	}
	return decoded;
}

/** Install decoded records into a store; order is irrelevant under the replay rule. */
export function applyRecords(store: ProtocolStore, records: DecodedRecords): void {
	for (const room of records.rooms) store.putRoom(room);
	for (const message of records.messages) store.putMessage(message);
	for (const message of records.embedded) store.putMessage(message);
	for (const reaction of records.reactions) store.putReaction(reaction);
}
