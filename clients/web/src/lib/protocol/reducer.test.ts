import { describe, expect, it } from 'vitest';
import { ProtocolStore, applyRecords, compareCodePoints, compareLogIds, decodeHistoryRecords, timelineEvents } from './reducer';
import { decodeMessage, decodeReactions, decodeRoom, isLogId, type MessageRecord } from './types';

const snapshot = (log: number, id = log, fields: Partial<MessageRecord> = {}): MessageRecord => ({
	message_id: String(id), log_id: String(log), room_id: 'general', from: { user_id: 'alice' }, body: { text: 'original' }, ...fields
});

function install(store: ProtocolStore, ...messages: MessageRecord[]): void {
	for (const message of messages) store.putMessage(message);
}

describe('message store', () => {
	it.each([5_000, 50_000])('replays %i messages in pages and builds a sorted timeline', (count) => {
		const store = new ProtocolStore();
		const base = 1_724_803_200_000;
		for (let offset = 0; offset < count; offset += 200) {
			install(store, ...Array.from({ length: Math.min(200, count - offset) }, (_, index) => snapshot(base + offset + index)));
		}
		install(store,
			snapshot(base + count, base, { body: { text: 'edited' } }),
			{ ...snapshot(base + count + 1, base + 1, { deleted: true }), body: undefined },
			snapshot(base)
		);
		const timeline = store.timeline('general');
		expect(timeline.order).toEqual(Array.from({ length: count }, (_, index) => String(base + index)));
		expect(timeline.events[String(base)].body?.text).toBe('edited');
		expect(timeline.events[String(base + 1)].deleted).toBe(true);
	});

	it('installs unloaded snapshots immediately and ignores older overlapping history', () => {
		const store = new ProtocolStore();
		install(store, snapshot(35, 20, { body: { text: 'newest' } }));
		expect(store.message('20')?.body?.text).toBe('newest');
		install(store, snapshot(30, 20), snapshot(40, 2), snapshot(20));
		expect(store.messageIdsIn('general')).toEqual(['2', '20']);
		expect(store.message('20')?.body?.text).toBe('newest');
	});

	it('orders IDs numerically', () => {
		expect(compareLogIds('9', '10')).toBe(-1);
		expect(compareLogIds('10', '10')).toBe(0);
		const store = new ProtocolStore();
		install(store, snapshot(12), snapshot(2), snapshot(12, 12, { body: { text: 'duplicate' } }));
		expect(timelineEvents(store.timeline('general')).map((message) => message.message_id)).toEqual(['2', '12']);
		expect(store.message('12')?.body?.text).toBe('original');
	});

	it('re-homes a moved message instead of duplicating it, and ignores a stale source snapshot', () => {
		const store = new ProtocolStore();
		install(store, snapshot(100), snapshot(105, 100, { room_id: 'thread' }));
		expect(store.messageIdsIn('general')).toEqual([]);
		expect(store.messageIdsIn('thread')).toEqual(['100']);
		install(store, snapshot(101, 100));
		expect(store.messageIdsIn('thread')).toEqual(['100']);
		expect(store.takeTouched()).toEqual(new Set(['general', 'thread']));
	});

	it('evicts by latest snapshot while retaining old message IDs with recent edits', () => {
		const store = new ProtocolStore();
		install(store, snapshot(2, 1), snapshot(8, 1, { body: { text: 'edited recently' } }), snapshot(3, 3));
		store.evictBefore('general', '8');
		expect(store.messageIdsIn('general')).toEqual(['1']);
		expect(store.message('1')?.body?.text).toBe('edited recently');
		expect(store.message('3')).toBeUndefined();
	});

	it('clears a room with its reaction sets but leaves other rooms alone', () => {
		const store = new ProtocolStore();
		install(store, snapshot(1), snapshot(2, 2, { room_id: 'other' }));
		for (const set of decodeReactions({ log_id: '3', message_id: '1', room_id: 'general', reactions: [{ from: { user_id: 'bob' }, emojis: ['👍'] }] })) store.putReaction(set);
		for (const set of decodeReactions({ log_id: '4', message_id: '9', room_id: 'general', reactions: [{ from: { user_id: 'bob' }, emojis: ['👍'] }] })) store.putReaction(set);
		store.clearRoom('general');
		expect(store.messageIdsIn('general')).toEqual([]);
		expect(store.reactionSet('1', 'bob')).toBeUndefined();
		expect(store.reactionSet('9', 'bob')).toBeUndefined();
		expect(store.messageIdsIn('other')).toEqual(['2']);
	});
});

describe('wire decoding', () => {
	it('keeps only protocol fields, copies ext exactly, and stores reply_to bare', () => {
		const wire = JSON.parse(`{
			"message_id": "700", "log_id": "701", "room_id": "general", "from": {"user_id": "alice"},
			"body": {"text": "hi", "embeds": [{"kind": "future", "x": null}]},
			"reply_to": {"message_id": "600", "log_id": "650", "room_id": "elsewhere", "from": {"user_id": "bob"}, "body": {"text": "target"}},
			"ext": {"example.org": {"nested": null}, "__proto__": {"opaque": true}},
			"__proto__": {"polluted": true}, "custom": 1
		}`);
		const decoded = decodeMessage(wire)!;
		expect(Object.keys(decoded.record).sort()).toEqual(['body', 'ext', 'from', 'log_id', 'message_id', 'reply_to', 'room_id']);
		expect(decoded.record.reply_to).toEqual({ message_id: '600' });
		expect(Object.hasOwn(decoded.record.ext!, '__proto__')).toBe(true);
		expect(JSON.parse(JSON.stringify(decoded.record.ext))).toEqual(JSON.parse('{"example.org": {"nested": null}, "__proto__": {"opaque": true}}'));
		expect(({} as { polluted?: boolean; opaque?: boolean }).polluted).toBeUndefined();
		expect(decoded.embedded.map((message) => [message.message_id, message.log_id, message.room_id])).toEqual([['600', '650', 'elsewhere']]);
	});

	it('rejects malformed IDs and missing authors', () => {
		expect(decodeMessage({ ...snapshot(1), log_id: 'not-an-id' })).toBeNull();
		expect(decodeMessage({ ...snapshot(1), log_id: '0' })).toBeNull();
		expect(decodeMessage({ message_id: '1', log_id: '1', room_id: 'general' })).toBeNull();
		expect(decodeMessage({ ...snapshot(1), room_id: undefined })).toBeNull();
		expect(isLogId('9007199254740992')).toBe(false);
		expect(isLogId('9007199254740991')).toBe(true);
	});

	it('separates room delivery fields and embedded intro snapshots from the record', () => {
		const decoded = decodeRoom({
			room_id: 't', log_id: '5', parent_room_id: 'general', title: 'Deploy', future: 1,
			intro_message: { message_id: '3', log_id: '4', room_id: 'general', from: { user_id: 'bob' }, body: { text: 'Deploy?' } },
			latest_log_id: '9', history_log_id: null
		})!;
		expect(JSON.parse(JSON.stringify(decoded.record))).toEqual({ room_id: 't', log_id: '5', parent_room_id: 'general', title: 'Deploy', intro_message: { message_id: '3' } });
		expect(decoded.delivery).toEqual({ latest_log_id: '9', history_log_id: null });
		expect(decoded.embedded[0].log_id).toBe('4');
	});

	it('replaces room records in full and lets a record without log_id always replace', () => {
		const store = new ProtocolStore();
		store.putRoom(decodeRoom({ room_id: 'general', log_id: '10', title: 'General', ext: { a: 1 } })!.record);
		expect(store.putRoom(decodeRoom({ room_id: 'general', log_id: '9', title: 'Stale' })!.record)).toBe(false);
		store.putRoom(decodeRoom({ room_id: 'general', log_id: '11' })!.record);
		expect(JSON.parse(JSON.stringify(store.room('general')))).toEqual({ room_id: 'general', log_id: '11' });
		store.putRoom(decodeRoom({ room_id: 'general', title: 'No history cap' })!.record);
		expect(store.room('general')?.title).toBe('No history cap');
	});

	it('reads title changes from every logged room record, whatever order they arrive in', () => {
		const store = new ProtocolStore();
		store.putRoom(decodeRoom({ room_id: 't1', log_id: '30', title: 'Deploy v2' })!.record);
		// History arrives after the live record: older records still count as renames.
		store.putRoom(decodeRoom({ room_id: 't1', log_id: '10', title: 'Deploy' })!.record);
		store.putRoom(decodeRoom({ room_id: 't1', log_id: '20', title: 'Deploy', ext: { a: 1 } })!.record);
		expect(store.roomRenames('t1')).toEqual([{ log_id: '30', title: 'Deploy v2', previous: 'Deploy' }]);
		expect(store.room('t1')?.title).toBe('Deploy v2');
	});
});

describe('reactions', () => {
	function react(store: ProtocolStore, log: number, message: string, user: string, emojis: string[]): void {
		for (const set of decodeReactions({ log_id: String(log), message_id: message, room_id: 'general', reactions: [{ from: { user_id: user, name: user.toUpperCase() }, emojis }] })) {
			store.putReaction(set);
		}
	}

	it('aggregates per emoji with counts, users, and whether you reacted', () => {
		const store = new ProtocolStore();
		install(store, snapshot(1));
		react(store, 2, '1', 'bob', ['👍']);
		react(store, 3, '1', 'carol', ['👍', '🎉', '👍']);
		expect(store.reactions('1', 'carol')).toEqual([
			{ emoji: '🎉', count: 1, user_ids: ['carol'], users: [{ user_id: 'carol', name: 'CAROL' }], mine: true },
			{ emoji: '👍', count: 2, user_ids: ['bob', 'carol'], users: [{ user_id: 'bob', name: 'BOB' }, { user_id: 'carol', name: 'CAROL' }], mine: true }
		]);
		expect(store.reactions('1', 'dave')?.every((entry) => !entry.mine)).toBe(true);
	});

	it('replaces per user by log_id, clears with [], and keeps sets for messages not loaded', () => {
		const store = new ProtocolStore();
		react(store, 4, '1', 'bob', ['👀']);
		react(store, 2, '1', 'bob', ['👍']);
		expect(store.reactions('1')).toBeUndefined();
		install(store, snapshot(1));
		expect(store.reactions('1')?.map((entry) => entry.emoji)).toEqual(['👀']);
		react(store, 5, '1', 'bob', []);
		expect(store.reactions('1')).toBeUndefined();
	});

	it('hides reactions on tombstones and sorts emoji by code point', () => {
		const store = new ProtocolStore();
		install(store, snapshot(1));
		react(store, 2, '1', 'bob', ['👍', '！']);
		expect(store.reactions('1')?.map((entry) => entry.emoji)).toEqual(['！', '👍']);
		expect(compareCodePoints('！', '👍')).toBe(-1);
		install(store, { ...snapshot(3, 1, { deleted: true }), body: undefined });
		expect(store.reactions('1')).toBeUndefined();
		expect(store.reactionSet('1', 'bob')?.emojis).toEqual(['👍', '！']);
	});
});

describe('history decoding', () => {
	it('installs every array regardless of the requested room', () => {
		const store = new ProtocolStore();
		applyRecords(store, decodeHistoryRecords({
			rooms: [{ room_id: 'general', log_id: '1', title: 'General' }],
			entries: [
				{ message_id: '2', log_id: '2', room_id: 'general', from: { user_id: 'a' }, body: { text: 'x' } },
				{ message_id: '2', log_id: '5', room_id: 'thread', from: { user_id: 'a' }, body: { text: 'x' } }
			],
			reactions: [{ log_id: '6', message_id: '2', room_id: 'thread', reactions: [{ from: { user_id: 'b' }, emojis: ['👍'] }, { from: { user_id: 'c' }, emojis: [] }] }],
			more: false, latest_log_id: '6', history_log_id: '1'
		}));
		expect(store.room('general')?.title).toBe('General');
		expect(store.messageIdsIn('thread')).toEqual(['2']);
		expect(store.reactions('2')?.map((entry) => entry.user_ids)).toEqual([['b']]);
	});
});
