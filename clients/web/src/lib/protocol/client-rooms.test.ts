import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, DEFAULT_ROOM_ID, type ClientSnapshot } from './client';
import { FakeSocket, settle } from './fake-socket';

/** Operations whose outcome a test does not await still settle when the client stops. */
function quiet(value: { promise: Promise<unknown> } | undefined): void {
	value?.promise.catch(() => undefined);
}

describe('rooms by request (cap rooms)', () => {
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

	const ids = () => snapshot.rooms.map((room) => room.id);
	const room = (id: string) => snapshot.rooms.find((candidate) => candidate.id === id);

	async function authenticate(caps: string[]): Promise<void> {
		socket.open();
		socket.receive({ method: 'server', params: { protocol: 5, auth: ['guest'], caps } });
		await socket.reply('auth', { you: { user_id: 'guest_1', name: 'Guest' } });
	}

	it('lists the joined rooms after auth, threads included, then follows room_update', async () => {
		await authenticate(['rooms']);
		expect(socket.request('room_list').params).toEqual({ only_joined: true });
		expect(snapshot.rooms).toEqual([]);
		await socket.reply('room_list', {
			joined: [
				{ room_id: 't1', log_id: '12', parent_room_id: 'general', title: 'Deploy', member_count: 2, members: [{ user_id: 'bob' }] },
				{ room_id: 'general', log_id: '10', title: 'General' }
			],
			users: [{ user_id: 'bob', name: 'Bob' }]
		});
		expect(ids()).toEqual(['t1', 'general']);
		// The first top-level room opens; a thread never does on its own.
		expect(snapshot.activeRoom).toBe('general');
		expect(room('t1')?.memberCount).toBe(2);
		expect(snapshot.users.bob).toEqual({ user_id: 'bob', name: 'Bob' });

		socket.receive({ method: 'room_update', params: { joined: [{ room_id: 'ops', log_id: '20', title: 'Ops' }] } });
		socket.receive({ method: 'room_update', params: { updated: [{ room_id: 'general', log_id: '21', title: 'General (ops)' }] } });
		expect(ids()).toEqual(['t1', 'general', 'ops']);
		expect(room('general')?.title).toBe('General (ops)');
		// A new thread in a joined room, not joined itself: listed to join, not visible.
		socket.receive({ method: 'room_update', params: { updated: [{ room_id: 't2', log_id: '22', parent_room_id: 'general', title: 'Incident' }] } });
		expect(ids()).not.toContain('t2');
		expect(snapshot.threadDirectory.general?.map((listing) => [listing.id, listing.title, listing.joined])).toEqual([['t2', 'Incident', false]]);
		socket.receive({ method: 'room_update', params: { left: [{ room_id: 'general' }] } });
		expect(ids()).toEqual(['t1', 'ops']);
		expect(snapshot.activeRoom).toBe('ops');
	});

	it('takes the joined set anew on each connection', async () => {
		await authenticate(['rooms']);
		await socket.reply('room_list', { joined: [{ room_id: 'general', title: 'General' }, { room_id: 'ops', title: 'Ops' }] });
		socket.drop();
		vi.advanceTimersByTime(5_000);
		socket = FakeSocket.latest();
		await authenticate(['rooms']);
		expect(snapshot.rooms).toEqual([]);
		await socket.reply('room_list', { joined: [{ room_id: 'ops', title: 'Ops' }] });
		expect(ids()).toEqual(['ops']);
	});

	it('shows transient notices in their room for the session and never stores them', async () => {
		await authenticate(['rooms']);
		await socket.reply('room_list', { joined: [{ room_id: 'general', title: 'General', latest_log_id: '30' }] });
		socket.receive({ method: 'message', params: { message_id: '31', log_id: '31', room_id: 'general', from: { user_id: 'bob' }, body: { text: 'hi' } } });
		socket.receive({ method: 'message', params: { room_id: 'general', from: { user_id: '@private', name: 'Only you' }, body: { text: 'Welcome', format: 'markdown' } } });
		// Without room_id it shows where you are.
		socket.receive({ method: 'message', params: { from: { user_id: '@private', name: 'Only you' }, body: { text: 'Unknown command /x; try /help' } } });
		client.notify('general', 'Only moderators can kick');
		const general = room('general')!;
		expect(general.timeline.order).toEqual(['31']);
		expect(general.notices.map((notice) => [notice.from.user_id, notice.body?.text, notice.after])).toEqual([
			['@private', 'Welcome', '31'],
			['@private', 'Unknown command /x; try /help', '31'],
			['@private', 'Only moderators can kick', '31']
		]);
		expect(snapshot.users['@private']).toBeUndefined();
		// Kept through a reconnect, for the session.
		socket.drop();
		vi.advanceTimersByTime(5_000);
		socket = FakeSocket.latest();
		await authenticate(['rooms']);
		await socket.reply('room_list', { joined: [{ room_id: 'general', title: 'General' }] });
		expect(room('general')?.notices).toHaveLength(3);
	});

	it('shows room @server once a notice lands there, as Server, listed last', async () => {
		await authenticate(['rooms']);
		await socket.reply('room_list', { joined: [{ room_id: 'general', title: 'General' }] });
		socket.receive({ method: 'message', params: { message_id: '40', log_id: '40', room_id: '@server', from: { user_id: '@server', name: 'Server' }, body: { text: 'Maintenance at 17:00' } } });
		socket.receive({ method: 'room_update', params: { joined: [{ room_id: 'ops', title: 'Ops' }] } });
		expect(snapshot.rooms.map((entry) => [entry.id, entry.title])).toEqual([['general', 'General'], ['ops', 'Ops'], ['@server', 'Server']]);
		expect(room('@server')?.timeline.order).toEqual(['40']);
		expect(snapshot.activeRoom).toBe('general');
		// A message in a room not joined is stored, not shown.
		socket.receive({ method: 'message', params: { message_id: '41', log_id: '41', room_id: 'elsewhere', from: { user_id: 'bob' }, body: { text: 'x' } } });
		expect(room('elsewhere')).toBeUndefined();
		expect(client.message('41')?.room_id).toBe('elsewhere');
	});

	it('sends commands with the params of a message, and never an empty message', async () => {
		await authenticate(['rooms', 'command', 'embed:upload']);
		await socket.reply('room_list', { joined: [{ room_id: 'general', title: 'General' }] });
		quiet(client.command('general', '/kick @bob spamming', { mentions: ['bob', 'bob'], replyTo: '31' }));
		expect(socket.request('command').params).toEqual({ room_id: 'general', body: { text: '/kick @bob spamming', mentions: ['bob'] }, reply_to: { message_id: '31' } });
		const failed = client.command('general', '/nope');
		socket.receive({ id: socket.request('command').id, error: { code: -32602, message: 'Unknown command /nope; try /help' } });
		await expect(failed.promise).rejects.toThrow('Unknown command /nope; try /help');
		// A command takes attached files as upload embeds, and its result lists their write URLs.
		vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 201 })));
		const { uploaded } = client.sendFiles('general', '/avatar', [new File(['png'], 'me.png')], 'markdown', {}, true);
		expect(socket.request('command').params).toEqual({ room_id: 'general', body: { text: '/avatar', embeds: [{ kind: 'upload', title: 'me.png' }] } });
		await socket.reply('command', { embeds: [{ embed_id: 'e1', kind: 'upload', write_url: 'http://fake.test/w/1' }] });
		await uploaded;
		// Mentions go in body.mentions.
		quiet(client.send('general', '@bob look', 'plain', { mentions: ['bob'] }));
		expect(socket.request('message').params).toEqual({ room_id: 'general', body: { text: '@bob look', format: 'plain', mentions: ['bob'] } });
		const before = socket.sent.length;
		await expect(client.send('general', '', 'plain').promise).rejects.toThrow('Nothing to send');
		expect(socket.sent).toHaveLength(before);
	});

	it('tells the server when nobody is attending, once per change and again on a new connection', async () => {
		await authenticate(['rooms', 'activity']);
		await socket.reply('room_list', { joined: [{ room_id: 'general', title: 'General' }] });
		const away = () => socket.sent.filter((frame) => frame.method === 'activity' && 'away' in (frame.params as object)).map((frame) => (frame.params as { away: boolean }).away);
		client.setAway(true);
		client.setAway(true);
		expect(away()).toEqual([true]);
		expect(socket.sent.find((frame) => frame.method === 'activity' && 'away' in (frame.params as object))).toEqual({ method: 'activity', params: { away: true } });
		client.setAway(false);
		expect(away()).toEqual([true, false]);
		// Typing ends away on the server: coming back needs no frame, going away again says so again.
		client.setAway(true);
		client.sendTyping('general', true);
		client.setAway(false);
		client.setAway(true);
		expect(away()).toEqual([true, false, true, true]);
		// A new connection starts attended: an away tab says so after auth.
		socket.drop();
		vi.advanceTimersByTime(5_000);
		socket = FakeSocket.latest();
		await authenticate(['rooms', 'activity']);
		expect(away()).toEqual([true]);
	});
});

describe('the default room (no cap rooms)', () => {
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

	it('posts without room_id until a broadcast names the room, and titles rooms by room_id', async () => {
		await socket.greet(['edit'], { rooms: false });
		expect(socket.sent.some((frame) => frame.method === 'room_list')).toBe(false);
		expect(snapshot.rooms.map((room) => room.id)).toEqual([DEFAULT_ROOM_ID]);
		expect(snapshot.activeRoom).toBe(DEFAULT_ROOM_ID);
		quiet(client.send(DEFAULT_ROOM_ID, 'hello', 'plain'));
		expect(socket.request('message').params).toEqual({ body: { text: 'hello', format: 'plain' } });
		await socket.reply('message', { message_id: '10' });
		socket.receive({ method: 'message', params: { message_id: '10', log_id: '10', room_id: 'lobby', from: { user_id: 'guest_1' }, body: { text: 'hello', format: 'plain' } } });
		expect(snapshot.rooms.map((room) => [room.id, room.title])).toEqual([['lobby', 'lobby']]);
		expect(snapshot.activeRoom).toBe('lobby');
		// Another room a message arrives in shows too.
		socket.receive({ method: 'message', params: { message_id: '11', log_id: '11', room_id: 'side', from: { user_id: 'bob' }, body: { text: 'x' } } });
		expect(snapshot.rooms.map((room) => room.id)).toEqual(['lobby', 'side']);
		await settle();
	});

	it('recovers a room shown for its messages up to the first one on each connection', async () => {
		await socket.greet(['history'], { rooms: false });
		socket.receive({ method: 'message', params: { message_id: '20', log_id: '20', room_id: 'lobby', from: { user_id: 'bob' }, body: { text: 'live' } } });
		expect(socket.request('history').params).toMatchObject({ room_id: 'lobby', after: '1', before: '20' });
		await socket.reply('history', { entries: [{ message_id: '15', log_id: '15', room_id: 'lobby', from: { user_id: 'bob' }, body: { text: 'old' } }], more: false, latest_log_id: '20', history_log_id: '1' });
		expect(snapshot.rooms[0].timeline.order).toEqual(['15', '20']);
		socket.receive({ method: 'message', params: { message_id: '21', log_id: '21', room_id: 'lobby', from: { user_id: 'bob' }, body: { text: 'next' } } });
		expect(socket.sent.filter((frame) => frame.method === 'history')).toHaveLength(1);
	});
});

describe('identity changes', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('lists the joined rooms again when the connection becomes another user', async () => {
		vi.useFakeTimers();
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
		const client = new ChatClient('ws://fake.test/');
		let snapshot: ClientSnapshot | undefined;
		client.subscribe((next) => (snapshot = next));
		client.start();
		const socket = FakeSocket.latest();
		await socket.greet([], { room: { room_id: 'general', title: 'General' } });
		socket.receive({ method: 'user', params: { you: { user_id: 'guest_1', name: 'Renamed' } } });
		expect(socket.sent.filter((frame) => frame.method === 'room_list')).toHaveLength(1);
		socket.receive({ method: 'user', params: { you: { user_id: 'ada', name: 'Ada' } } });
		expect(socket.sent.filter((frame) => frame.method === 'room_list')).toHaveLength(2);
		await socket.reply('room_list', { joined: [{ room_id: 'ops', title: 'Ops' }] });
		expect(snapshot?.rooms.map((room) => room.id)).toEqual(['ops']);
		client.stop();
	});
});
