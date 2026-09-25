import { childRooms, timelineMessages, type Notice, type RoomListing, type RoomRename, type RoomSnapshot } from '$lib/protocol/client';
import { compareLogIds } from '$lib/protocol/reducer';
import { isLogId, type Identity, type MessageRecord } from '$lib/protocol/types';
import { embedsOf, senderName, textOf } from './messages';
import { dayKey, dayKeyOf, dayLabel, dayLabelOf, eventTime, idTime, isGrouped } from './time';

/** Longest title a thread started from a message gets, in characters. */
export const THREAD_TITLE_MAX = 60;

/**
 * A thread as the sidebar and the room feed see it: a room with a
 * `parent_room_id` (PROTOCOL.md §3.4), plus what its loaded messages add.
 */
export interface ThreadEntry {
	/** The thread's own `room_id`. */
	id: string;
	parentRoomId: string;
	title: string;
	introMessageId?: string;
	/** The latest known snapshot of the intro message, wherever it lives. */
	introMessage?: MessageRecord;
	/** Messages in the thread; only known once its history has loaded. */
	count?: number;
	loaded: boolean;
	participants: Identity[];
	lastReply: string;
	latestMessage?: MessageRecord;
	/**
	 * Where the card sits in the parent room's feed: the intro message's ID
	 * when there is one, else the thread's creation (its `room_id` when that is
	 * a log ID, as both example servers mint it, or its record's `log_id`).
	 */
	anchor?: string;
	/**
	 * The viewer has joined the thread (§4.3.2). A thread not joined is known
	 * from `room_list` or a `room_update`: it still gets a card, and opening it
	 * joins it.
	 */
	joined: boolean;
}

export type TimelineItem =
	| { kind: 'date'; key: string; label: string }
	| { kind: 'message'; key: string; event: MessageRecord; grouped: boolean; intro?: boolean }
	| { kind: 'thread'; key: string; entry: ThreadEntry }
	| { kind: 'replies'; key: string; count: number; more?: boolean }
	| { kind: 'renamed'; key: string; logId: string; title: string }
	| { kind: 'notice'; key: string; notice: Notice };

/**
 * The rooms the sidebar lists at the top level: rooms without a parent, and
 * threads whose parent is not visible (so they stay reachable).
 */
export function sidebarRooms(rooms: readonly RoomSnapshot[]): RoomSnapshot[] {
	const visible = new Set(rooms.map((room) => room.id));
	return rooms.filter((room) => room.parentRoomId === undefined || !visible.has(room.parentRoomId));
}

/** The top-level room a room belongs to: its parent for a visible thread, else itself. */
export function homeRoomOf(rooms: readonly RoomSnapshot[], roomId: string): string {
	const room = rooms.find((candidate) => candidate.id === roomId);
	const parent = room?.parentRoomId;
	return parent !== undefined && rooms.some((candidate) => candidate.id === parent) ? parent : roomId;
}

/** One thread room as a card and sidebar row. */
export function threadEntry(room: RoomSnapshot): ThreadEntry {
	const messages = timelineMessages(room);
	let participants: Identity[] = [];
	for (const event of messages) {
		if (!event.from?.user_id || event.deleted) continue;
		participants = [event.from, ...participants.filter((sender) => sender.user_id !== event.from.user_id)].slice(0, 4);
	}
	const latest = messages[messages.length - 1];
	const anchor = room.introMessageId ?? (isLogId(room.id) ? room.id : room.record?.log_id);
	return {
		id: room.id,
		parentRoomId: room.parentRoomId ?? '',
		title: room.title,
		...(room.introMessageId !== undefined ? { introMessageId: room.introMessageId } : {}),
		...(room.introMessage ? { introMessage: room.introMessage } : {}),
		...(room.loaded ? { count: messages.length } : {}),
		loaded: room.loaded,
		participants,
		lastReply: latest ? eventTime(latest) : '',
		...(latest ? { latestMessage: latest } : {}),
		...(anchor !== undefined ? { anchor } : {}),
		joined: true
	};
}

/** A thread the viewer has not joined, from a listing: a card without a count, since its history isn't loaded. */
export function unjoinedThreadEntry(listing: RoomListing, message?: (messageId: string) => MessageRecord | undefined): ThreadEntry {
	const introId = listing.record.intro_message?.message_id;
	const intro = introId !== undefined ? message?.(introId) : undefined;
	const anchor = introId ?? (isLogId(listing.id) ? listing.id : listing.record.log_id);
	return {
		id: listing.id,
		parentRoomId: listing.parentRoomId ?? '',
		title: listing.title,
		...(introId !== undefined ? { introMessageId: introId } : {}),
		...(intro ? { introMessage: intro } : {}),
		loaded: false,
		participants: [],
		lastReply: listing.latestLogId !== undefined ? idTime(listing.latestLogId) : '',
		...(anchor !== undefined ? { anchor } : {}),
		joined: false
	};
}

/**
 * The threads of a room: the joined ones in listing order, then the ones
 * listed as not joined (`unjoined`, from `room_list` with `parent_room_id`).
 */
export function threadEntries(
	rooms: readonly RoomSnapshot[], parentRoomId: string | undefined, unjoined: readonly RoomListing[] = [],
	message?: (messageId: string) => MessageRecord | undefined
): ThreadEntry[] {
	if (parentRoomId === undefined) return [];
	const joined = childRooms(rooms, parentRoomId).map(threadEntry);
	const known = new Set(joined.map((entry) => entry.id));
	return [...joined, ...unjoined.filter((listing) => !known.has(listing.id)).map((listing) => unjoinedThreadEntry(listing, message))];
}

/**
 * The preview under a thread's title: its intro message's author and up to
 * three lines of its body when it is available (in the room feed the card
 * stands in for that message), else the newest loaded message as "Dana: text"
 * on one line.
 */
export function threadPreview(entry: ThreadEntry): { label: string; text: string; intro: boolean } | undefined {
	const intro = entry.introMessage;
	if (intro && !intro.deleted && textOf(intro).trim()) return { label: senderName(intro), text: textOf(intro).trim(), intro: true };
	const event = entry.latestMessage;
	if (!event) return undefined;
	if (event.deleted) return { label: '', text: 'Message deleted', intro: false };
	const text = textOf(event).replace(/\s+/g, ' ').trim();
	return { label: senderName(event), text: text || (embedsOf(event).length ? 'Attachment' : 'Empty message'), intro: false };
}

/** A title for a thread started from a message: its first non-empty line, shortened, else "Thread". */
export function threadTitleFor(event: MessageRecord | undefined): string {
	const line = (event && !event.deleted ? textOf(event) : '').split('\n').find((part) => part.trim())?.replace(/\s+/g, ' ').trim() ?? '';
	const chars = [...line];
	if (chars.length > THREAD_TITLE_MAX) return `${chars.slice(0, THREAD_TITLE_MAX - 1).join('').trimEnd()}…`;
	return line || 'Thread';
}

export interface RoomTimelineInput {
	/** The room's own messages, in timeline order. */
	messages: MessageRecord[];
	/** The room's threads. */
	threads: ThreadEntry[];
	/** Transient notices shown in the room (§3.5), in arrival order. */
	notices?: readonly Notice[];
	now?: Date;
}

/**
 * Hands out a room's notices in timeline order: each goes after the messages
 * whose `message_id` is at most its position, the newest the room had when it
 * arrived.
 */
function noticeQueue(notices: readonly Notice[]): (before?: string) => Notice[] {
	const queue = [...notices].sort((a, b) => compareLogIds(a.after, b.after) || a.at - b.at);
	let next = 0;
	return (before) => {
		const start = next;
		while (next < queue.length && (before === undefined || compareLogIds(queue[next].after, before) < 0)) next++;
		return queue.slice(start, next);
	};
}

/**
 * The room view: its messages in order, with each thread's card. A message
 * that is the intro of one of the room's threads is shown as that thread's
 * card; other threads' cards sit where they were started (their anchor).
 * Date dividers split days.
 */
export function buildRoomTimeline({ messages, threads, notices = [], now = new Date() }: RoomTimelineInput): TimelineItem[] {
	const here = new Set(messages.map((event) => event.message_id));
	const byIntro = new Map<string, ThreadEntry[]>();
	const floating: ThreadEntry[] = [];
	for (const entry of threads) {
		if (entry.introMessageId !== undefined && here.has(entry.introMessageId)) {
			byIntro.set(entry.introMessageId, [...(byIntro.get(entry.introMessageId) ?? []), entry]);
		} else {
			floating.push(entry);
		}
	}
	// Floating cards merge in by anchor; one without an anchor goes last.
	floating.sort((a, b) => (a.anchor === undefined ? 1 : b.anchor === undefined ? -1 : compareLogIds(a.anchor, b.anchor)));

	const items: TimelineItem[] = [];
	let lastDay = '';
	let previous: MessageRecord | undefined;
	const pushDate = (day: string, label: () => string) => {
		if (day && day !== lastDay) {
			items.push({ kind: 'date', key: `date:${day}`, label: label() });
			lastDay = day;
			previous = undefined;
		}
	};
	const pushCard = (entry: ThreadEntry) => {
		if (entry.anchor !== undefined) pushDate(dayKeyOf(entry.anchor), () => dayLabelOf(entry.anchor!, now));
		items.push({ kind: 'thread', key: `thread:${entry.id}`, entry });
		previous = undefined;
	};
	const pending = noticeQueue(notices);
	// A notice is a system line: it never groups with the messages around it.
	const pushNotices = (before?: string) => {
		for (const notice of pending(before)) {
			items.push({ kind: 'notice', key: notice.key, notice });
			previous = undefined;
		}
	};
	let next = 0;
	for (const event of messages) {
		while (next < floating.length && floating[next].anchor !== undefined && compareLogIds(floating[next].anchor!, event.message_id) < 0) {
			pushCard(floating[next++]);
		}
		pushNotices(event.message_id);
		const cards = byIntro.get(event.message_id);
		if (cards) {
			for (const entry of cards) pushCard(entry);
			continue;
		}
		pushDate(dayKey(event), () => dayLabel(event, now));
		items.push({ kind: 'message', key: event.message_id, event, grouped: isGrouped(previous, event) });
		previous = event;
	}
	while (next < floating.length) pushCard(floating[next++]);
	pushNotices();
	return items;
}

export interface ThreadTimelineInput {
	/** The thread room's own messages, in timeline order. */
	messages: MessageRecord[];
	/** The thread's intro message, wherever it lives, when known. */
	intro?: MessageRecord;
	/** The thread room's title changes, ascending. */
	renames?: readonly RoomRename[];
	now?: Date;
	/** Older replies are not loaded yet: the count is a lower bound. */
	moreReplies?: boolean;
	/** Transient notices shown in the thread (§3.5), in arrival order. */
	notices?: readonly Notice[];
}

/**
 * The thread view: the intro message leads, then an "N replies" divider and
 * the thread's other messages, with a "Thread renamed" line where each title
 * change was logged. Without an intro it is just the messages, with date
 * dividers.
 */
export function buildThreadTimeline({ messages, intro, renames = [], now = new Date(), moreReplies = false, notices = [] }: ThreadTimelineInput): TimelineItem[] {
	const items: TimelineItem[] = [];
	let lastDay = '';
	let previous: MessageRecord | undefined;
	const rest = intro ? messages.filter((event) => event.message_id !== intro.message_id) : messages;
	if (intro) {
		items.push({ kind: 'message', key: intro.message_id, event: intro, grouped: false, intro: true });
		lastDay = dayKey(intro);
		if (rest.length > 0) items.push({ kind: 'replies', key: 'replies', count: rest.length, ...(moreReplies ? { more: true } : {}) });
	}
	const pushDay = (id: string) => {
		const day = dayKeyOf(id);
		if (!day || day === lastDay) return;
		items.push({ kind: 'date', key: `date:${day}`, label: dayLabelOf(id, now) });
		lastDay = day;
		previous = undefined;
	};
	let next = 0;
	const pushRenames = (before?: string) => {
		for (; next < renames.length && (before === undefined || compareLogIds(renames[next].log_id, before) < 0); next++) {
			const rename = renames[next];
			pushDay(rename.log_id);
			items.push({ kind: 'renamed', key: `renamed:${rename.log_id}`, logId: rename.log_id, title: rename.title });
			previous = undefined;
		}
	};
	const pending = noticeQueue(notices);
	const pushNotices = (before?: string) => {
		for (const notice of pending(before)) {
			items.push({ kind: 'notice', key: notice.key, notice });
			previous = undefined;
		}
	};
	for (const event of rest) {
		pushRenames(event.message_id);
		pushNotices(event.message_id);
		pushDay(event.message_id);
		items.push({ kind: 'message', key: event.message_id, event, grouped: isGrouped(previous, event) });
		previous = event;
	}
	pushRenames();
	pushNotices();
	return items;
}
