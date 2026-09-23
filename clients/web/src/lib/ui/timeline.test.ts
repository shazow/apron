import { describe, expect, it } from 'vitest';
import { createTimeline, type TimelineState } from '$lib/protocol/reducer';
import type { RoomSnapshot } from '$lib/protocol/client';
import type { MessageRecord } from '$lib/protocol/types';
import { buildRoomTimeline, buildThreadTimeline, homeRoomOf, sidebarRooms, threadEntries, threadEntry, threadPreview, threadTitleFor, type TimelineItem } from './timeline';
import { isGrouped, dayLabel, GROUP_WINDOW_MS } from './time';
import { peopleIn, rangeBetween, replySnippet, spanOf } from './messages';

const DAY = 24 * 60 * 60 * 1000;
const base = Date.UTC(2026, 8, 14, 12, 0, 0);

const message = (offset: number, from: string, fields: Partial<MessageRecord> = {}): MessageRecord => ({
	message_id: String(base + offset),
	log_id: String(base + offset),
	room_id: 'general',
	from: { user_id: from, name: from[0].toUpperCase() + from.slice(1) },
	body: { text: `${from} says ${offset}` },
	...fields
});

function timeline(roomId: string, messages: MessageRecord[]): TimelineState {
	const state = createTimeline(roomId);
	return { ...state, events: Object.fromEntries(messages.map((event) => [event.message_id, event])), order: messages.map((event) => event.message_id) };
}

function room(id: string, messages: MessageRecord[] = [], fields: Partial<RoomSnapshot> = {}): RoomSnapshot {
	return { id, title: id, timeline: timeline(id, messages), recovering: false, loaded: true, loading: false, ...fields };
}

const kinds = (items: TimelineItem[]) => items.map((item) => item.kind);

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
		expect(dayLabel(message(0, 'alice', { message_id: 'opaque' }), now)).toBe('');
	});
});

describe('thread grouping', () => {
	const general = room('general');
	const ops = room('ops');
	const deploy = room('t1', [], { parentRoomId: 'general', title: 'Deploy' });
	const orphan = room('t2', [], { parentRoomId: 'gone', title: 'Orphan' });

	it('lists top-level rooms, keeps threads under their parent, and keeps orphaned threads reachable', () => {
		const rooms = [general, deploy, ops, orphan];
		expect(sidebarRooms(rooms).map((entry) => entry.id)).toEqual(['general', 'ops', 't2']);
		expect(threadEntries(rooms, 'general').map((entry) => entry.id)).toEqual(['t1']);
		expect(threadEntries(rooms, 'ops')).toEqual([]);
		expect(threadEntries(rooms, undefined)).toEqual([]);
		expect(homeRoomOf(rooms, 't1')).toBe('general');
		expect(homeRoomOf(rooms, 't2')).toBe('t2');
		expect(homeRoomOf(rooms, 'ops')).toBe('ops');
	});

	it('counts a thread’s messages only once its history has loaded, and shows its newest faces', () => {
		const first = message(1000, 'bob', { room_id: 't1' });
		const second = message(2000, 'dana', { room_id: 't1' });
		const third = message(3000, 'bob', { room_id: 't1', deleted: true, body: undefined });
		const loaded = threadEntry(room('t1', [first, second, third], { parentRoomId: 'general', title: 'Deploy' }));
		expect(loaded).toMatchObject({ id: 't1', parentRoomId: 'general', title: 'Deploy', count: 3, loaded: true, latestMessage: third });
		expect(loaded.participants.map((person) => person.user_id)).toEqual(['dana', 'bob']);
		const partial = threadEntry(room('t1', [first], { parentRoomId: 'general', loaded: false }));
		expect(partial.count).toBeUndefined();
		expect(partial.latestMessage).toBe(first);
	});

	it('anchors a card at its intro, else at the thread’s creation', () => {
		expect(threadEntry(room(String(base + 5000), [], { parentRoomId: 'general', introMessageId: String(base) })).anchor).toBe(String(base));
		expect(threadEntry(room(String(base + 5000), [], { parentRoomId: 'general' })).anchor).toBe(String(base + 5000));
		expect(threadEntry(room('opaque', [], { parentRoomId: 'general', record: { room_id: 'opaque', log_id: '42' } })).anchor).toBe('42');
	});

	it('previews up to the intro’s full text, else the latest message on one line', () => {
		const intro = message(0, 'alice', { body: { text: 'Line one\nLine two\nLine three\nLine four' } });
		const latest = message(1000, 'bob', { room_id: 't1', body: { text: 'latest\n  words' } });
		const entry = threadEntry(room('t1', [latest], { parentRoomId: 'general', introMessageId: intro.message_id, introMessage: intro }));
		expect(threadPreview(entry)).toEqual({ label: 'Alice', text: 'Line one\nLine two\nLine three\nLine four', intro: true });
		expect(threadPreview({ ...entry, introMessage: { ...intro, deleted: true, body: undefined } })).toEqual({ label: 'Bob', text: 'latest words', intro: false });
		expect(threadPreview({ ...entry, introMessage: undefined, latestMessage: { ...latest, deleted: true } })).toEqual({ label: '', text: 'Message deleted', intro: false });
		expect(threadPreview({ ...entry, introMessage: undefined, latestMessage: message(1, 'bob', { body: { embeds: [{ kind: 'image' }] } }) })).toMatchObject({ text: 'Attachment' });
		expect(threadPreview({ ...entry, introMessage: undefined, latestMessage: undefined })).toBeUndefined();
	});

	it('titles a new thread after its message’s first line', () => {
		expect(threadTitleFor(message(0, 'alice', { body: { text: '\n  Deploy   the thing \nmore' } }))).toBe('Deploy the thing');
		expect([...threadTitleFor(message(0, 'alice', { body: { text: 'x'.repeat(80) } }))]).toHaveLength(60);
		expect(threadTitleFor(message(0, 'alice', { body: { embeds: [{ kind: 'image' }] } }))).toBe('Thread');
		expect(threadTitleFor(undefined)).toBe('Thread');
	});
});

describe('room view', () => {
	const now = new Date(base + 2 * DAY);
	const intro = message(0, 'alice');
	const plain = message(1000, 'bob');
	const later = message(2 * DAY, 'alice');
	const introduced = threadEntry(room('t1', [], { parentRoomId: 'general', title: 'Deploy', introMessageId: intro.message_id, introMessage: intro }));
	// A thread created from a selection whose intro then moved into the thread.
	const moved = threadEntry(room('t2', [], { parentRoomId: 'general', title: 'Moved', introMessageId: String(base + 1500) }));
	const bare = threadEntry(room(String(base + DAY), [], { parentRoomId: 'general', title: 'Bare' }));

	it('shows a thread’s intro as its card, other cards at their anchors, and date dividers', () => {
		const items = buildRoomTimeline({ messages: [intro, plain, later], threads: [introduced, moved, bare], now });
		expect(kinds(items)).toEqual(['date', 'thread', 'message', 'thread', 'date', 'thread', 'date', 'message']);
		expect(items[1]).toMatchObject({ key: 'thread:t1' });
		expect(items[2]).toMatchObject({ event: plain, grouped: false });
		expect(items[3]).toMatchObject({ key: 'thread:t2' });
		expect(items[5]).toMatchObject({ key: `thread:${base + DAY}` });
		expect(items[6]).toMatchObject({ label: 'Today' });
	});

	it('is just the messages without threads', () => {
		const items = buildRoomTimeline({ messages: [intro, message(1000, 'alice')], threads: [], now });
		expect(kinds(items)).toEqual(['date', 'message', 'message']);
		expect(items[2]).toMatchObject({ grouped: true });
		expect(buildRoomTimeline({ messages: [], threads: [bare], now }).map((item) => item.kind)).toEqual(['date', 'thread']);
	});
});

describe('thread view', () => {
	it('leads with the intro, then "N replies" and the thread’s messages', () => {
		const intro = message(0, 'alice');
		const reply = message(1000, 'bob', { room_id: 't1' });
		const second = message(5000, 'alice', { room_id: 't1' });
		const items = buildThreadTimeline({ messages: [reply, second], intro });
		expect(kinds(items)).toEqual(['message', 'replies', 'message', 'message']);
		expect(items[0]).toMatchObject({ event: intro, intro: true });
		expect(items[1]).toMatchObject({ count: 2 });
		expect(items[2]).toMatchObject({ grouped: false });
	});

	it('shows an intro that lives in the thread once, and no divider without replies', () => {
		const intro = message(0, 'alice', { room_id: 't1' });
		expect(kinds(buildThreadTimeline({ messages: [intro], intro }))).toEqual(['message']);
		const reply = message(1000, 'bob', { room_id: 't1' });
		expect(kinds(buildThreadTimeline({ messages: [intro, reply], intro }))).toEqual(['message', 'replies', 'message']);
	});

	it('is just its messages with date dividers when there is no intro', () => {
		const items = buildThreadTimeline({ messages: [message(1000, 'bob'), message(2000, 'bob')] });
		expect(kinds(items)).toEqual(['date', 'message', 'message']);
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
