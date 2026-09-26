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
		socket.receive({ method: 'server', params: { protocol: 6, auth: ['guest'], caps } });
		await socket.reply('auth', { you: { user_id: 'guest_1', name: 'Guest' } });
	}

	it('lists the joined rooms with their members right behind auth, threads included, then follows room_update', async () => {
		socket.open();
		socket.receive({ method: 'server', params: { protocol: 6, auth: ['guest'], caps: ['rooms'] } });
		// Auth is a barrier (§3.2): the listing goes out before its result.
		expect(socket.sent.map((frame) => frame.method)).toEqual(['auth', 'room_list']);
		expect(socket.request('room_list').params).toEqual({ filter: 'joined', members: true });
		await socket.reply('auth', { you: { user_id: 'guest_1', name: 'Guest' } });
		expect(snapshot.rooms).toEqual([]);
		await socket.reply('room_list', {
			joined: [
				{ room_id: 't1', log_id: '12', parent_room_id: 'general', title: 'Deploy', members: [{ user_id: 'bob' }, { user_id: 'guest_1' }] },
				{ room_id: 'general', log_id: '10', title: 'General', members: [{ user_id: 'guest_1' }] }
			],
			users: [{ user_id: 'bob', name: 'Bob' }, { user_id: 'guest_1', name: 'Guest' }]
		});
		expect(ids()).toEqual(['t1', 'general']);
		expect(snapshot.rooms.every((entry) => entry.joined)).toBe(true);
		// The first top-level room opens; a thread never does on its own.
		expect(snapshot.activeRoom).toBe('general');
		expect(room('t1')?.members).toEqual([{ user_id: 'bob' }, { user_id: 'guest_1' }]);
		expect(snapshot.users.bob).toEqual({ user_id: 'bob', name: 'Bob' });

		socket.receive({ method: 'room_update', params: { joined: [{ room_id: 'ops', log_id: '20', title: 'Ops', members: [{ user_id: 'dana' }, { user_id: 'guest_1' }] }], users: [{ user_id: 'dana', name: 'Dana' }] } });
		expect(room('ops')?.members?.map((member) => member.user_id)).toEqual(['dana', 'guest_1']);
		expect(snapshot.users.dana).toEqual({ user_id: 'dana', name: 'Dana' });
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

	it('shows a welcome sent before auth in the first room, and lets the next connection\'s welcome replace it', async () => {
		const welcome = (text: string) => ({ method: 'message', params: { from: { user_id: '@private', name: 'Only you' }, body: { text } } });
		socket.open();
		socket.receive({ method: 'server', params: { protocol: 6, auth: ['guest'], caps: ['rooms'] } });
		// Notifications may come before auth (§3.2); with no room yet, it waits for one (Appendix B).
		socket.receive(welcome('Guests can read along.'));
		await socket.reply('auth', { you: { user_id: 'guest_1', name: 'Guest' } });
		await socket.reply('room_list', { joined: [{ room_id: 'general', title: 'General', latest_log_id: '30' }] });
		socket.receive({ method: 'message', params: { room_id: 'general', from: { user_id: '@private' }, body: { text: 'A command reply' } } });
		const texts = () => room('general')?.notices.map((notice) => notice.body?.text);
		expect(texts()).toEqual(['Guests can read along.', 'A command reply']);
		// The server sends its welcome on every connection: the new one replaces the old.
		socket.drop();
		vi.advanceTimersByTime(5_000);
		socket = FakeSocket.latest();
		socket.open();
		socket.receive({ method: 'server', params: { protocol: 6, auth: ['guest'], caps: ['rooms'] } });
		socket.receive(welcome('Guests can read along, again.'));
		await socket.reply('auth', { you: { user_id: 'guest_1', name: 'Guest' } });
		await socket.reply('room_list', { joined: [{ room_id: 'general', title: 'General' }] });
		expect(texts()).toEqual(['A command reply', 'Guests can read along, again.']);
	});

	it('treats room IDs starting with @ as ordinary rooms and has no Server room', async () => {
		await authenticate(['rooms']);
		await socket.reply('room_list', { joined: [{ room_id: '@ops', title: 'At ops' }, { room_id: 'general', title: 'General' }] });
		expect(snapshot.rooms.map((entry) => [entry.id, entry.title])).toEqual([['@ops', 'At ops'], ['general', 'General']]);
		expect(snapshot.activeRoom).toBe('@ops');
		// A server-wide notice names a room like any message; a room not joined is not shown for it.
		socket.receive({ method: 'message', params: { message_id: '40', log_id: '40', room_id: 'general', from: { user_id: '@server', name: 'Server' }, body: { text: 'Maintenance at 17:00' } } });
		expect(room('general')?.timeline.order).toEqual(['40']);
		expect(room('general')?.notices).toEqual([]);
		expect(room('@server')).toBeUndefined();
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

	it('keeps member lists from listings and memberships, whichever order they arrive in', async () => {
		await authenticate(['rooms', 'history']);
		// A guest's own join may arrive before anything is listed (the Go server logs it at auth).
		socket.receive({ method: 'membership', params: { log_id: '11', room_id: 'general', members: [{ user: { user_id: 'guest_1', name: 'Guest' }, joined: true }] } });
		await socket.reply('room_list', { joined: [{ room_id: 'general', log_id: '10', title: 'General', latest_log_id: '11', history_log_id: '10', members: [{ user_id: 'bob' }, { user_id: 'guest_1' }] }], users: [] });
		await socket.reply('history', { membership: [{ log_id: '11', room_id: 'general', members: [{ user: { user_id: 'guest_1' }, joined: true }] }], first_log_id: '11', last_log_id: '11', more: false, latest_log_id: '11', history_log_id: '10' });
		expect(room('general')?.members?.map((member) => member.user_id)).toEqual(['bob', 'guest_1']);
		// Joining: the membership, then the room with its members, then the result (§4.3.2).
		const joined = client.joinRoom('ops');
		socket.receive({ method: 'membership', params: { log_id: '21', room_id: 'ops', members: [{ user: { user_id: 'guest_1', name: 'Guest' }, joined: true }] } });
		socket.receive({ method: 'room_update', params: { joined: [{ room_id: 'ops', log_id: '20', title: 'Ops', latest_log_id: '21', history_log_id: '20', members: [{ user_id: 'dana' }, { user_id: 'guest_1' }] }], users: [{ user_id: 'dana', name: 'Dana' }, { user_id: 'guest_1', name: 'Guest' }] } });
		expect(ids()).toEqual(['general', 'ops']);
		await socket.reply('room_join', {});
		await expect(joined.promise).resolves.toEqual({});
		// Creating: the room with its members, then the creator's membership at its head, then the result.
		const created = client.createRoom({ parentRoomId: 'general', title: 'Deploy' });
		socket.receive({ method: 'room_update', params: { joined: [{ room_id: '30', log_id: '30', parent_room_id: 'general', title: 'Deploy', latest_log_id: '30', history_log_id: '30', members: [{ user_id: 'guest_1' }] }], users: [{ user_id: 'guest_1', name: 'Guest' }] } });
		socket.receive({ method: 'membership', params: { log_id: '30', room_id: '30', members: [{ user: { user_id: 'guest_1', name: 'Guest' }, joined: true }] } });
		expect(room('30')?.members).toEqual([{ user_id: 'guest_1' }]);
		await socket.reply('room_set', { room_id: '30' });
		await expect(created.promise).resolves.toEqual({ room_id: '30' });
		// Someone else leaves, then is removed from a thread: the lists follow.
		socket.receive({ method: 'membership', params: { log_id: '31', room_id: 'ops', members: [{ user: { user_id: 'dana', name: 'Dana' }, joined: false }] } });
		expect(room('ops')?.members?.map((member) => member.user_id)).toEqual(['guest_1']);
		expect(room('ops')?.latestLogId).toBe('31');
		// Your own leave: the membership, then the room goes.
		socket.receive({ method: 'membership', params: { log_id: '32', room_id: 'ops', members: [{ user: { user_id: 'guest_1' }, joined: false }] } });
		socket.receive({ method: 'room_update', params: { left: [{ room_id: 'ops' }] } });
		expect(ids()).toEqual(['general', '30']);
		await settle();
	});

	it('does not report a listing denied behind a failed auth', async () => {
		socket.open();
		socket.receive({ method: 'server', params: { protocol: 6, auth: ['guest'], caps: ['rooms'] } });
		const auth = socket.request('auth');
		const listing = socket.request('room_list');
		socket.receive({ id: auth.id, error: { code: -32001, message: 'Guests are not accepted right now' } });
		await settle();
		socket.receive({ id: listing.id, error: { code: -32001, message: 'Denied' } });
		await settle();
		expect(snapshot.error).toBe('Guests are not accepted right now');
		expect(snapshot.authenticated).toBe(false);
		expect(snapshot.rooms).toEqual([]);
	});

	it('opens a thread without joining it: history only, until joined', async () => {
		await authenticate(['rooms', 'history']);
		await socket.reply('room_list', { joined: [{ room_id: 'general', log_id: '10', title: 'General', latest_log_id: '12', history_log_id: '10', members: [{ user_id: 'guest_1' }] }], users: [] });
		await socket.reply('history', { more: false, latest_log_id: '12', history_log_id: '10' });
		const threads = client.listRooms('general');
		await socket.reply('room_list', { not_joined: [{ room_id: '20', log_id: '20', parent_room_id: 'general', title: 'Deploy', latest_log_id: '24', history_log_id: '20' }] });
		await threads;
		expect(client.viewRoom('20')).toBe(true);
		expect(room('20')).toMatchObject({ joined: false, loaded: false, parentRoomId: 'general' });
		expect(snapshot.threadDirectory.general[0].joined).toBe(false);
		expect(socket.sent.some((frame) => frame.method === 'room_join')).toBe(false);
		const load = client.loadRoom('20');
		expect(socket.request('history').params).toEqual({ room_id: '20', before: '24', limit: 50 });
		await socket.reply('history', { messages: [{ message_id: '21', log_id: '21', room_id: '20', from: { user_id: 'bob' }, body: { text: 'first' } }], first_log_id: '21', last_log_id: '24', more: false, latest_log_id: '24', history_log_id: '20' });
		await load;
		expect(room('20')).toMatchObject({ joined: false, loaded: true });
		expect(room('20')?.timeline.order).toEqual(['21']);
		// Nothing about it arrives live: a later listing of the parent's threads moves its head, and it loads again.
		const relisted = client.listRooms('general', 0);
		await socket.reply('room_list', { not_joined: [{ room_id: '20', log_id: '20', parent_room_id: 'general', title: 'Deploy', latest_log_id: '26', history_log_id: '20' }] });
		await relisted;
		expect(room('20')?.loaded).toBe(false);
		const again = client.loadRoom('20');
		expect(socket.request('history').params).toEqual({ room_id: '20', after: '25', before: '26', limit: 200 });
		await socket.reply('history', { messages: [{ message_id: '26', log_id: '26', room_id: '20', from: { user_id: 'bob' }, body: { text: 'second' } }], first_log_id: '26', last_log_id: '26', more: false, latest_log_id: '26', history_log_id: '20' });
		await again;
		expect(room('20')?.timeline.order).toEqual(['21', '26']);
		// Joining makes it live; what it missed since its last load is caught up on the next load.
		quiet(client.joinRoom('20'));
		socket.receive({ method: 'membership', params: { log_id: '28', room_id: '20', members: [{ user: { user_id: 'guest_1' }, joined: true }] } });
		socket.receive({ method: 'room_update', params: { joined: [{ room_id: '20', log_id: '20', parent_room_id: 'general', title: 'Deploy', latest_log_id: '28', history_log_id: '20', members: [{ user_id: 'bob' }, { user_id: 'guest_1' }] }], users: [] } });
		expect(room('20')).toMatchObject({ joined: true, loaded: false });
		const caught = client.loadRoom('20');
		expect(socket.request('history').params).toEqual({ room_id: '20', after: '27', before: '28', limit: 200 });
		await socket.reply('history', { messages: [{ message_id: '27', log_id: '27', room_id: '20', from: { user_id: 'bob' }, body: { text: 'third' } }], membership: [{ log_id: '28', room_id: '20', members: [{ user: { user_id: 'guest_1' }, joined: true }] }], first_log_id: '27', last_log_id: '28', more: false, latest_log_id: '28', history_log_id: '20' });
		await caught;
		expect(room('20')).toMatchObject({ joined: true, loaded: true });
		expect(room('20')?.timeline.order).toEqual(['21', '26', '27']);
		socket.receive({ method: 'message', params: { message_id: '29', log_id: '29', room_id: '20', from: { user_id: 'bob' }, body: { text: 'live' } } });
		expect(room('20')?.timeline.order).toEqual(['21', '26', '27', '29']);
		expect(room('20')?.loaded).toBe(true);
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
		await socket.reply('history', { messages: [{ message_id: '15', log_id: '15', room_id: 'lobby', from: { user_id: 'bob' }, body: { text: 'old' } }], more: false, latest_log_id: '20', history_log_id: '1' });
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
