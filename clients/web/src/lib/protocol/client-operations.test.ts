import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, childRooms, findMessage, topLevelRooms, type ClientSnapshot } from './client';
import { FakeSocket, settle } from './fake-socket';

const alice = { user_id: 'alice', name: 'Alice' };

/** Operations whose outcome a test does not await still settle when the client stops. */
function quiet(handle: { promise: Promise<unknown> } | undefined): void {
	handle?.promise.catch(() => undefined);
}

function message(id: string, fields: Record<string, unknown> = {}, log = id): Record<string, unknown> {
	return { message_id: id, log_id: log, room_id: 'general', from: alice, body: { text: `m${id}` }, ...fields };
}

describe('ChatClient v3 operations', () => {
	let client: ChatClient;
	let snapshot: ClientSnapshot;
	let socket: FakeSocket;

	beforeEach(() => {
		vi.useFakeTimers();
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
		client = new ChatClient('ws://fake.test/');
		client.subscribe((next) => (snapshot = next));
		client.start();
		socket = FakeSocket.latest();
	});

	afterEach(() => {
		client.stop();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	async function connect(caps = ['edit', 'rooms', 'reactions']): Promise<void> {
		await socket.greet(caps, { room: { room_id: 'general', log_id: '10', title: 'General' } });
		socket.receive({ method: 'room', params: { room_id: 'thread', log_id: '20', parent_room_id: 'general', title: 'Side', intro_message: { message_id: '100' } } });
	}

	const room = (id: string) => snapshot.rooms.find((entry) => entry.id === id)!;

	it('authenticates as a guest and sends plain messages with bare cross-room replies', async () => {
		await connect();
		expect(socket.request('auth').params).toMatchObject({ scheme: 'guest' });
		quiet(client.send('thread', 'hello', undefined, { replyTo: '100' }));
		expect(socket.request('message').params).toEqual({ room_id: 'thread', body: { text: 'hello', format: 'plain' }, reply_to: { message_id: '100' } });
		expect(snapshot.pending.map((entry) => entry.room)).toEqual(['thread']);
	});

	it('exposes room records, the parent relationship, and falls back to room_id for titles', async () => {
		await connect();
		socket.receive({ method: 'room', params: { room_id: 'ops' } });
		expect(snapshot.activeRoom).toBe('general');
		expect(topLevelRooms(snapshot.rooms).map((entry) => entry.id)).toEqual(['general', 'ops']);
		expect(childRooms(snapshot.rooms, 'general').map((entry) => [entry.id, entry.title, entry.introMessageId])).toEqual([['thread', 'Side', '100']]);
		expect(room('ops').title).toBe('ops');
		expect(room('thread').introMessage).toBeUndefined();
		socket.receive({ method: 'message', params: message('100') });
		expect(room('thread').introMessage?.body).toEqual({ text: 'm100' });
		socket.receive({ method: 'room', params: { room_id: 'general', removed: true } });
		expect(snapshot.activeRoom).toBe('ops');
	});

	it('resubmits ext exactly, reply_to bare, and the rest of the body on edits', async () => {
		await connect();
		const ext = JSON.parse('{"example.org": {"nested": null}, "__proto__": {"opaque": true}}');
		socket.receive({ method: 'message', params: message('100', {
			body: { text: 'old', format: 'markdown', embeds: [{ kind: 'future' }] },
			reply_to: { message_id: '50', log_id: '50', room_id: 'elsewhere', from: alice, body: { text: 'target' } },
			ext
		}) });
		expect(client.message('50')?.room_id).toBe('elsewhere');
		quiet(client.editMessage('100', 'new'));
		const params = socket.request('message').params;
		expect(JSON.parse(JSON.stringify(params))).toEqual(JSON.parse(JSON.stringify({
			message_id: '100', room_id: 'general', body: { text: 'new', format: 'markdown', embeds: [{ kind: 'future' }] },
			reply_to: { message_id: '50' }, ext
		})));
		expect(JSON.stringify(params)).toContain('"__proto__":{"opaque":true}');
		quiet(client.setMessageReply('100', null));
		expect(socket.request('message').params).not.toHaveProperty('reply_to');
		quiet(client.deleteMessage('100'));
		const deleted = socket.request('message').params;
		expect(deleted).not.toHaveProperty('body');
		expect(deleted).toMatchObject({ message_id: '100', room_id: 'general', deleted: true, reply_to: { message_id: '50' } });
	});

	it('rejects saves of messages that are not loaded without sending anything', async () => {
		await connect();
		const handle = client.editMessage('404', 'nope');
		await expect(handle.promise).rejects.toThrow('Message has not been loaded');
		expect(socket.sent.some((frame) => frame.method === 'message')).toBe(false);
	});

	it('re-homes a moved message and its reactions into the destination room', async () => {
		await connect();
		socket.receive({ method: 'message', params: message('100') });
		socket.receive({ method: 'reactions', params: { log_id: '101', message_id: '100', room_id: 'general', reactions: [{ from: { user_id: 'bob' }, emojis: ['👍'] }] } });
		expect(room('general').timeline.reactions['100']?.[0]).toMatchObject({ emoji: '👍', count: 1, user_ids: ['bob'], mine: false });
		quiet(client.moveMessage('100', 'thread'));
		expect(socket.request('message').params).toEqual({ message_id: '100', room_id: 'thread', body: { text: 'm100' } });
		socket.receive({ method: 'message', params: message('100', { room_id: 'thread' }, '102') });
		expect(room('general').timeline.order).toEqual([]);
		expect(room('thread').timeline.order).toEqual(['100']);
		expect(room('thread').timeline.reactions['100']?.[0].user_ids).toEqual(['bob']);
		expect(findMessage(snapshot.rooms, '100')?.room_id).toBe('thread');
	});

	it('sets, toggles, and clears your own reactions and hides them on tombstones', async () => {
		await connect();
		socket.receive({ method: 'message', params: message('100') });
		quiet(client.toggleReaction('100', '👍'));
		expect(socket.request('reactions').params).toEqual({ message_id: '100', emojis: ['👍'] });
		// A second toggle before the broadcast builds on the pending set.
		quiet(client.toggleReaction('100', '🎉'));
		expect(socket.request('reactions').params).toEqual({ message_id: '100', emojis: ['👍', '🎉'] });
		socket.receive({ method: 'reactions', params: { log_id: '101', message_id: '100', room_id: 'general', reactions: [{ from: { user_id: 'guest_1' }, emojis: ['👍', '🎉'] }] } });
		await socket.reply('reactions', {});
		expect(client.ownReactions('100')).toEqual(['👍', '🎉']);
		expect(room('general').timeline.reactions['100']?.map((entry) => [entry.emoji, entry.mine])).toEqual([['🎉', true], ['👍', true]]);
		quiet(client.toggleReaction('100', '👍'));
		expect(socket.request('reactions').params).toEqual({ message_id: '100', emojis: ['🎉'] });
		socket.receive({ method: 'message', params: { ...message('100', { deleted: true }, '103'), body: undefined } });
		expect(room('general').timeline.reactions['100']).toBeUndefined();
		expect(client.reactions('100')).toBeUndefined();
	});

	it('creates threads and updates rooms from the latest record', async () => {
		await connect();
		quiet(client.createRoom({ parentRoomId: 'general', title: 'Deploy', introMessageId: '100' }));
		expect(socket.request('room').params).toEqual({ parent_room_id: 'general', title: 'Deploy', intro_message: { message_id: '100' } });
		socket.receive({ method: 'room', params: { room_id: 'thread', log_id: '21', parent_room_id: 'general', title: 'Side', intro_message: { message_id: '100' }, ext: { x: { y: 1 } } } });
		quiet(client.updateRoom('thread', { title: 'Renamed' }));
		expect(socket.request('room').params).toEqual({ room_id: 'thread', title: 'Renamed', intro_message: { message_id: '100' }, ext: { x: { y: 1 } } });
		quiet(client.updateRoom('thread', { introMessageId: null, ext: null }));
		expect(socket.request('room').params).toEqual({ room_id: 'thread', title: 'Side' });
	});

	it('renames with the name method and adopts the answered identity', async () => {
		await connect();
		quiet(client.setDisplayName('Ada'));
		expect(socket.request('name').params).toEqual({ name: 'Ada' });
		await socket.reply('name', { you: { user_id: 'guest_1', name: 'Ada!' } });
		expect(snapshot.you).toEqual({ user_id: 'guest_1', name: 'Ada!' });
	});

	it('refuses to authenticate with an older protocol', async () => {
		socket.open();
		socket.receive({ method: 'server', params: { protocol: 2, auth: ['anonymous'] } });
		expect(socket.sent).toEqual([]);
		expect(snapshot.error).toMatch(/protocol 2/);
	});
});

describe('ChatClient history per room', () => {
	let client: ChatClient;
	let snapshot: ClientSnapshot;
	let socket: FakeSocket;

	beforeEach(async () => {
		vi.useFakeTimers();
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
		client = new ChatClient('ws://fake.test/');
		client.subscribe((next) => (snapshot = next));
		client.start();
		socket = FakeSocket.latest();
		await socket.greet(['history', 'rooms'], { room: { room_id: 'general', log_id: '10', title: 'General', latest_log_id: '12', history_log_id: '10' } });
	});

	afterEach(() => {
		client.stop();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	const room = (id: string) => snapshot.rooms.find((entry) => entry.id === id)!;

	it('holds the published timeline until the recovery completes', async () => {
		expect(socket.request('history').params).toEqual({ room_id: 'general', after: '10', before: '12', limit: 200 });
		socket.receive({ method: 'message', params: message('13') });
		expect(room('general')).toMatchObject({ recovering: true, loaded: false });
		expect(room('general').timeline.order).toEqual([]);
		// Operations already see the live record.
		expect(client.message('13')?.log_id).toBe('13');
		await socket.reply('history', { rooms: [{ room_id: 'general', log_id: '10', title: 'General' }], entries: [message('11'), message('12')], more: false, latest_log_id: '13', history_log_id: '10' });
		expect(room('general')).toMatchObject({ recovering: false, loaded: true });
		expect(room('general').timeline.order).toEqual(['11', '12', '13']);
	});

	it('loads a thread room only when asked, as its own room', async () => {
		await socket.reply('history', { entries: [], more: false, latest_log_id: '12', history_log_id: '10' });
		socket.receive({ method: 'room', params: { room_id: '20', log_id: '20', parent_room_id: 'general', title: 'Side', latest_log_id: '22', history_log_id: '20' } });
		expect(socket.sent.filter((frame) => frame.method === 'history')).toHaveLength(1);
		expect(room('20')).toMatchObject({ parentRoomId: 'general', loaded: false, loading: false });
		const loaded = client.loadRoom('20');
		expect(socket.request('history').params).toEqual({ room_id: '20', after: '20', before: '22', limit: 200 });
		expect(room('20').loading).toBe(true);
		await socket.reply('history', { entries: [message('21', { room_id: '20' }), message('22', { room_id: '20' })], more: false, latest_log_id: '22', history_log_id: '20' });
		await loaded;
		expect(room('20')).toMatchObject({ loaded: true, loading: false });
		expect(room('20').timeline.order).toEqual(['21', '22']);
		expect(room('general').timeline.order).toEqual([]);
	});

	it('retries a failed top-level recovery through loadRoom', async () => {
		socket.receive({ id: socket.request('history').id, error: { code: -32002, message: 'Busy', data: { ms: 10 } } });
		await settle();
		expect(room('general').recoveryError).toMatch(/Busy/);
		const retried = client.loadRoom('general');
		expect(socket.request('history').params).toMatchObject({ after: '10', before: '12' });
		await socket.reply('history', { entries: [message('11')], more: false, latest_log_id: '12', history_log_id: '10' });
		await retried;
		expect(room('general').recoveryError).toBeUndefined();
		expect(room('general').timeline.order).toEqual(['11']);
	});

	it('flushes requests queued before authentication once auth succeeds', async () => {
		socket.drop();
		vi.advanceTimersByTime(5_000);
		const next = FakeSocket.latest();
		next.open();
		next.receive({ method: 'server', params: { protocol: 3, auth: ['guest'], caps: [] } });
		quiet(client.send('general', 'queued'));
		expect(next.sent.some((frame) => frame.method === 'message')).toBe(false);
		next.receive({ id: next.request('auth').id, result: { you: { user_id: 'guest_2' } } });
		await settle();
		expect(next.request('message').params).toMatchObject({ room_id: 'general', body: { text: 'queued', format: 'plain' } });
	});
});
