import { describe, expect, it } from 'vitest';
import type { RoomSnapshot } from '$lib/protocol/client';
import type { MessageRecord } from '$lib/protocol/types';
import { buildTimeline, threadEntries, threadPreview } from './timeline';
import { isGrouped, dayLabel, GROUP_WINDOW_MS } from './time';
import { peopleIn, rangeBetween, replySnippet, spanOf } from './messages';

const DAY = 24 * 60 * 60 * 1000;
const base = Date.UTC(2026, 8, 14, 12, 0, 0);

const message = (offset: number, from: string, fields: Partial<MessageRecord> = {}): MessageRecord => ({
	message_id: String(base + offset),
	from: { user_id: from, name: from[0].toUpperCase() + from.slice(1) },
	body: { text: `${from} says ${offset}` },
	...fields
});

function room(messages: MessageRecord[], threads: RoomSnapshot['threads'] = []): RoomSnapshot {
	const events = Object.fromEntries(messages.map((event) => [event.message_id, event]));
	return { id: 'general', name: 'General', timeline: { room: 'general', order: messages.map((m) => m.message_id), events, latestLogs: {} }, threads, recovering: false };
}

describe('grouping', () => {
	it('groups a sender’s consecutive messages inside the window', () => {
		expect(isGrouped(message(0, 'alice'), message(1000, 'alice'))).toBe(true);
		expect(isGrouped(message(0, 'alice'), message(GROUP_WINDOW_MS, 'alice'))).toBe(false);
		expect(isGrouped(message(0, 'alice'), message(1000, 'bob'))).toBe(false);
		expect(isGrouped(undefined, message(0, 'alice'))).toBe(false);
	});

	it('labels days relative to now', () => {
		const now = new Date(base + 6 * 60 * 60 * 1000);
		expect(dayLabel(message(0, 'alice'), now)).toBe('Today');
		expect(dayLabel(message(-DAY, 'alice'), now)).toBe('Yesterday');
		expect(dayLabel(message(-3 * DAY, 'alice'), now)).not.toMatch(/Today|Yesterday/);
		expect(dayLabel({ message_id: 'opaque', from: { user_id: 'a' } }, now)).toBe('');
	});
});

describe('room view', () => {
	const root = message(0, 'alice');
	const reply = message(1000, 'bob', { thread_id: 't_1' });
	const later = message(2 * DAY, 'alice');
	const orphan = message(3000, 'dana', { thread_id: 't_unknown' });
	const messages = [root, reply, later, orphan];
	const snapshot = room(messages, [{ room_id: 'general', thread_id: 't_1', title: 'Deploy', root_message_id: root.message_id }]);

	it('lists announced and merely seen threads with counts and faces', () => {
		const entries = threadEntries(snapshot, messages);
		expect(entries.map((entry) => [entry.thread_id, entry.announced, entry.count])).toEqual([['t_1', true, 1], ['t_unknown', false, 1]]);
		expect(entries[0].participants.map((p) => p.user_id)).toEqual(['bob']);
		expect(entries[0].latestMessage).toBe(reply);
		expect(threadPreview(entries[0])).toEqual({ label: 'Bob', text: 'bob says 1000', summary: false });
		expect(threadPreview({ ...entries[0], summary: 'Settled' })).toEqual({ label: 'Summary', text: 'Settled', summary: true });
	});

	it('shows unthreaded messages, each announced thread’s summary row, and date dividers', () => {
		const entries = threadEntries(snapshot, messages);
		const threadsByRoot = new Map(entries.filter((e) => e.announced && e.root_message_id).map((e) => [e.root_message_id!, e]));
		const items = buildTimeline({ messages, threadsByRoot, now: new Date(base + 2 * DAY) });
		expect(items.map((item) => item.kind)).toEqual(['date', 'message', 'date', 'message']);
		expect(items[0]).toMatchObject({ label: dayLabel(root, new Date(base + 2 * DAY)) });
		expect(items[2]).toMatchObject({ label: 'Today' });
		// A root that is itself in the thread appears as its summary row, not a message.
		const rootInThread = { ...root, thread_id: 't_1' };
		const withRoot = buildTimeline({ messages: [rootInThread, reply, later], threadsByRoot, now: new Date(base + 2 * DAY) });
		expect(withRoot.map((item) => item.kind)).toEqual(['date', 'thread', 'date', 'message']);
	});

	it('builds a thread view as root, "N replies", then the replies', () => {
		const rootInThread = { ...root, thread_id: 't_1' };
		const second = message(5000, 'alice', { thread_id: 't_1' });
		const items = buildTimeline({ messages: [rootInThread, reply, second, later], threadsByRoot: new Map(), thread: 't_1', threadRoot: root.message_id });
		expect(items.map((item) => item.kind)).toEqual(['message', 'replies', 'message', 'message']);
		expect(items[1]).toMatchObject({ count: 2 });
		expect(items[3]).toMatchObject({ grouped: false });
		// Without an announced root the thread is just its messages.
		const plain = buildTimeline({ messages: [reply, second], threadsByRoot: new Map(), thread: 't_1' });
		expect(plain.map((item) => item.kind)).toEqual(['date', 'message', 'message']);
	});
});

describe('message helpers', () => {
	it('quotes the first non-empty line, shortened', () => {
		expect(replySnippet(message(0, 'alice', { body: { text: '\n\n  first line  \nsecond' } }))).toBe('first line');
		expect(replySnippet(message(0, 'alice', { body: { text: 'x'.repeat(130) } }))).toHaveLength(120);
		expect(replySnippet(message(0, 'alice', { body: { embeds: [{ kind: 'image' }] } }))).toBe('Attachment');
		expect(replySnippet(message(0, 'alice', { body: {} }))).toBe('Empty message');
	});

	it('lists the people a room has seen, newest first, with the viewer always present', () => {
		const me = { user_id: 'sam', name: 'Sam' };
		const people = peopleIn([message(0, 'alice'), message(1, 'bob'), message(2, 'alice')], me);
		expect(people.map((p) => [p.id, p.me ?? false])).toEqual([['alice', false], ['bob', false], ['sam', true]]);
		expect(peopleIn([message(0, 'sam')], me)).toEqual([{ id: 'sam', name: 'Sam', me: true }]);
	});

	it('fills ranges along the timeline order', () => {
		const order = ['a', 'b', 'c', 'd', 'e'];
		expect(rangeBetween(order, 'd', 'b')).toEqual(['b', 'c', 'd']);
		expect(rangeBetween(order, 'a', 'zz')).toEqual(['a', 'zz']);
		expect(spanOf(order, ['e', 'b'])).toEqual(['b', 'c', 'd', 'e']);
		expect(spanOf(order, ['c'])).toEqual(['c']);
	});
});
