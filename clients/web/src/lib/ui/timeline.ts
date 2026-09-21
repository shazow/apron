import type { RoomSnapshot } from '$lib/protocol/client';
import type { Identity, MessageRecord, ThreadAnnouncement } from '$lib/protocol/types';
import { embedsOf, senderName, textOf } from './messages';
import { dayKey, dayLabel, eventTime, isGrouped } from './time';

/** A thread as the sidebar and the room feed see it: the announcement plus what its messages add. */
export type ThreadEntry = ThreadAnnouncement & {
	title: string;
	count: number;
	/** False for a thread only known from its messages, which the server hasn't announced (yet). */
	announced: boolean;
	participants: Identity[];
	lastReply: string;
	latestMessage?: MessageRecord;
};

export type TimelineItem =
	| { kind: 'date'; key: string; label: string }
	| { kind: 'message'; key: string; event: MessageRecord; grouped: boolean }
	| { kind: 'thread'; key: string; entry: ThreadEntry }
	| { kind: 'replies'; key: string; count: number };

/** Every thread of a room, announced or merely seen, with its counts, faces and newest message. */
export function threadEntries(room: RoomSnapshot | undefined, messages: MessageRecord[]): ThreadEntry[] {
	const entries = new Map<string, ThreadEntry>();
	for (const announcement of room?.threads ?? []) {
		const root = announcement.root_message_id ? room?.timeline.events[announcement.root_message_id] : undefined;
		const excerpt = root && !root.deleted ? textOf(root).replace(/\s+/g, ' ').trim().slice(0, 60) : '';
		const title = announcement.title && announcement.title !== announcement.thread_id
			? announcement.title : excerpt || announcement.thread_id;
		entries.set(announcement.thread_id, { ...announcement, title, count: 0, announced: true, participants: [], lastReply: '' });
	}
	for (const event of messages) {
		if (!event.thread_id) continue;
		let entry = entries.get(event.thread_id);
		if (!entry) {
			entry = { room_id: room?.id ?? '', thread_id: event.thread_id, title: event.thread_id, count: 0, announced: false, participants: [], lastReply: '' };
			entries.set(event.thread_id, entry);
		}
		entry.count += 1;
		entry.lastReply = eventTime(event);
		entry.latestMessage = event;
		if (event.from?.user_id && !event.deleted) {
			entry.participants = [event.from, ...entry.participants.filter((sender) => sender.user_id !== event.from?.user_id)].slice(0, 4);
		}
	}
	return [...entries.values()];
}

/** The preview line under a thread's root: its summary, else the newest reply as "Dana: text". */
export function threadPreview(entry: ThreadEntry): { label: string; text: string; summary: boolean } | undefined {
	if (entry.summary !== undefined) return { label: 'Summary', text: entry.summary, summary: true };
	const event = entry.latestMessage;
	if (!event) return undefined;
	if (event.deleted) return { label: '', text: 'Message deleted', summary: false };
	const text = textOf(event).replace(/\s+/g, ' ').trim();
	return { label: senderName(event), text: text || (embedsOf(event).length ? 'Attachment' : 'Empty message'), summary: false };
}

export interface TimelineInput {
	/** Every message of the room, threads included, in timeline order. */
	messages: MessageRecord[];
	/** Announced threads by their root message, for the summary rows in the room view. */
	threadsByRoot: Map<string, ThreadEntry>;
	/** The open thread, or undefined for the room view. */
	thread?: string;
	/** The open thread's root, when it is announced. */
	threadRoot?: string;
	now?: Date;
}

/**
 * The main pane shows one place. The room view: messages with no thread, plus
 * each announced thread's root and its summary row. A thread view: its root,
 * a "N replies" divider, then the replies. Date dividers split days in both.
 */
export function buildTimeline({ messages, threadsByRoot, thread, threadRoot, now = new Date() }: TimelineInput): TimelineItem[] {
	const items: TimelineItem[] = [];
	let lastDay = '';
	let previous: MessageRecord | undefined;
	const pushDate = (event: MessageRecord) => {
		const day = dayKey(event);
		if (day && day !== lastDay) {
			items.push({ kind: 'date', key: `date:${day}`, label: dayLabel(event, now) });
			lastDay = day;
			previous = undefined;
		}
	};
	const pushMessage = (event: MessageRecord) => {
		pushDate(event);
		items.push({ kind: 'message', key: event.message_id, event, grouped: isGrouped(previous, event) });
		previous = event;
	};
	if (thread) {
		const [first, ...rest] = messages.filter((event) => event.thread_id === thread);
		if (first && first.message_id === threadRoot) {
			items.push({ kind: 'message', key: first.message_id, event: first, grouped: false });
			lastDay = dayKey(first);
			if (rest.length > 0) items.push({ kind: 'replies', key: 'replies', count: rest.length });
			for (const event of rest) pushMessage(event);
		} else if (first) {
			for (const event of [first, ...rest]) pushMessage(event);
		}
		return items;
	}
	for (const event of messages) {
		if (!event.thread_id) {
			pushMessage(event);
			continue;
		}
		const entry = threadsByRoot.get(event.message_id);
		if (entry) {
			pushDate(event);
			items.push({ kind: 'thread', key: `thread:${entry.thread_id}`, entry });
			previous = undefined;
		}
	}
	return items;
}
