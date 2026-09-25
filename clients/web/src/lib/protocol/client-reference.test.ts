import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, userIn, type ClientSnapshot } from './client';
import { safeAvatar, safeLink, sameOriginMedia, serverOrigin } from './embeds';
import { FakeSocket, settle } from './fake-socket';

/** Operations whose outcome a test does not await still settle when the client stops. */
function quiet(value: { promise: Promise<unknown> } | Promise<unknown> | undefined): void {
	(value && 'promise' in value ? value.promise : value)?.catch(() => undefined);
}

describe('ChatClient reference features', () => {
	let client: ChatClient;
	let snapshot: ClientSnapshot;
	let socket: FakeSocket;

	beforeEach(() => {
		vi.useFakeTimers();
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
		client = new ChatClient('ws://fake.test/ws');
		client.subscribe((next) => (snapshot = next));
		client.start();
		socket = FakeSocket.latest();
	});

	afterEach(() => {
		client.stop();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	async function connect(caps = ['history', 'rooms', 'activity', 'embed:upload']): Promise<void> {
		await socket.greet(caps, { room: { room_id: 'general', log_id: '10', title: 'General', latest_log_id: '10', history_log_id: '10' } });
		await socket.reply('history', { entries: [], more: false, latest_log_id: '10', history_log_id: '10' });
	}

	it('merges user objects field by field, and a from only when its message is newer', async () => {
		await connect();
		expect(snapshot.users.guest_1).toEqual({ user_id: 'guest_1', name: 'Guest' });
		socket.receive({ method: 'message', params: { message_id: '20', log_id: '20', room_id: 'general', from: { user_id: 'bob', name: 'Bob' }, body: { text: 'hi' } } });
		expect(snapshot.users.bob).toEqual({ user_id: 'bob', name: 'Bob' });
		// A present field replaces, a missing one is left alone.
		socket.receive({ method: 'user', params: { new: { user_id: 'bob', name: 'Bobby', avatar: 'https://example.com/b.png' } } });
		socket.receive({ method: 'message', params: { message_id: '21', log_id: '21', room_id: 'general', from: { user_id: 'bob', name: 'Robert' }, body: { text: 'hi' } } });
		expect(snapshot.users.bob).toEqual({ user_id: 'bob', name: 'Robert', avatar: 'https://example.com/b.png' });
		// A bare object changes nothing; an empty value removes the field.
		socket.receive({ method: 'user', params: { new: { user_id: 'bob' } } });
		expect(snapshot.users.bob).toEqual({ user_id: 'bob', name: 'Robert', avatar: 'https://example.com/b.png' });
		socket.receive({ method: 'user', params: { new: { user_id: 'bob', avatar: '', ext: {} } } });
		expect(snapshot.users.bob).toEqual({ user_id: 'bob', name: 'Robert' });
		// An older from, embedded or an edit of an old message, never brings back an old name.
		socket.receive({ method: 'message', params: { message_id: '22', log_id: '22', room_id: 'general', from: { user_id: 'carol', name: 'Carol' }, body: { text: 'hi' }, reply_to: { message_id: '19', log_id: '19', room_id: 'general', from: { user_id: 'bob', name: 'Old Bob' }, body: {} } } });
		socket.receive({ method: 'message', params: { message_id: '20', log_id: '23', room_id: 'general', from: { user_id: 'bob', name: 'Bob' }, body: { text: 'edited' } } });
		expect(snapshot.users.bob.name).toBe('Robert');
		// Another user object moves the position to the greatest log_id received: a from of an
		// older message stays out, one of a newer message comes in.
		socket.receive({ method: 'user', params: { new: { user_id: 'carol', name: 'Caroline' } } });
		socket.receive({ method: 'message', params: { message_id: '22', log_id: '24', room_id: 'general', from: { user_id: 'carol', name: 'Carol' }, body: { text: 'edited' } } });
		expect(snapshot.users.carol.name).toBe('Caroline');
		socket.receive({ method: 'message', params: { message_id: '25', log_id: '25', room_id: 'general', from: { user_id: 'carol', name: 'Cara' }, body: { text: 'new' } } });
		expect(snapshot.users.carol.name).toBe('Cara');
		// A user_id change aliases the old ID to the new identity.
		socket.receive({ method: 'user', params: { new: { user_id: 'ada', name: 'Ada' }, old: { user_id: 'guest_9', name: 'Guest 9' } } });
		expect(userIn(snapshot, { user_id: 'guest_9' })).toEqual({ user_id: 'ada', name: 'Ada' });
		// `you` merges into this connection's identity.
		socket.receive({ method: 'user', params: { you: { user_id: 'guest_1', avatar: 'https://example.com/me.png' } } });
		expect(snapshot.you).toEqual({ user_id: 'guest_1', name: 'Guest', avatar: 'https://example.com/me.png' });
		expect(snapshot.users.guest_1).toBe(snapshot.you);
	});

	it('merges a history page\'s users after its records, over older names in from', async () => {
		await socket.greet(['history', 'rooms'], { room: { room_id: 'general', log_id: '10', title: 'General', latest_log_id: '12', history_log_id: '10' } });
		await socket.reply('history', {
			entries: [
				{ message_id: '11', log_id: '11', room_id: 'general', from: { user_id: 'bob', name: 'Bob then' }, body: { text: 'a' } },
				{ message_id: '12', log_id: '12', room_id: 'general', from: { user_id: 'bob', name: 'Bob later' }, body: { text: 'b' } }
			],
			users: [{ user_id: 'bob', name: 'Bob now', avatar: 'https://example.com/b.png' }],
			more: false, latest_log_id: '12', history_log_id: '10'
		});
		expect(snapshot.users.bob).toEqual({ user_id: 'bob', name: 'Bob now', avatar: 'https://example.com/b.png' });
	});

	it('tracks read cursors forward only and advances your own with activity', async () => {
		await connect();
		const general = () => snapshot.rooms.find((room) => room.id === 'general')!;
		socket.receive({ method: 'activity', params: { room_id: 'general', from: { user_id: 'guest_1' }, read_message_id: '30' } });
		expect(general().readMessageId).toBe('30');
		socket.receive({ method: 'activity', params: { room_id: 'general', from: { user_id: 'guest_1' }, read_message_id: '25' } });
		expect(general().readMessageId).toBe('30');
		socket.sent = [];
		client.markRead('general', '29');
		expect(socket.sent).toEqual([]);
		client.markRead('general', '31');
		expect(socket.sent).toEqual([{ method: 'activity', params: { room_id: 'general', read_message_id: '31' } }]);
		expect(general().readMessageId).toBe('31');
		// Others' cursors do not move yours.
		socket.receive({ method: 'activity', params: { room_id: 'general', from: { user_id: 'bob' }, read_message_id: '40' } });
		expect(general().readMessageId).toBe('31');
	});

	it('keeps your read cursor locally when the server keeps none', async () => {
		await socket.greet(['history', 'rooms', 'activity'], {
			room: { room_id: 'general', log_id: '10', title: 'General', latest_log_id: '10', history_log_id: '10' },
			ext: { demo: { read_cursors: false } }
		});
		await socket.reply('history', { entries: [], more: false, latest_log_id: '10', history_log_id: '10' });
		socket.sent = [];
		client.markRead('general', '31');
		expect(socket.sent).toEqual([]);
		expect(snapshot.rooms.find((room) => room.id === 'general')?.readMessageId).toBe('31');
	});

	it('lists rooms and threads to join, and one room with its members', async () => {
		await connect();
		const listing = client.listRooms();
		expect(socket.request('room_list').params).toEqual({ not_joined: true });
		await socket.reply('room_list', { rooms: [
			{ room_id: 'ops', log_id: '11', latest_log_id: '11', member_count: 3 },
			{ room_id: 'general', log_id: '10', title: 'General', latest_log_id: '12' }
		] });
		const rooms = await listing;
		expect(rooms.map((room) => [room.id, room.title, room.joined, room.memberCount])).toEqual([['ops', 'ops', false, 3], ['general', 'General', true, undefined]]);
		expect(snapshot.directory?.map((room) => room.id)).toEqual(['ops', 'general']);
		quiet(client.listRooms('general'));
		expect(socket.request('room_list').params).toEqual({ parent_room_id: 'general', not_joined: true });
		await socket.reply('room_list', { rooms: [{ room_id: 't1', log_id: '13', parent_room_id: 'general', title: 'Thread' }] });
		expect(snapshot.threadDirectory.general.map((room) => room.id)).toEqual(['t1']);
		// Members may come bare, with the complete objects in the result's users.
		quiet(client.listMembers('general'));
		expect(socket.request('room_list').params).toEqual({ room_id: 'general' });
		await socket.reply('room_list', {
			joined: [{ room_id: 'general', log_id: '10', title: 'General', latest_log_id: '12', member_count: 2, members: [{ user_id: 'guest_1' }, { user_id: 'bob' }] }],
			users: [{ user_id: 'guest_1', name: 'Guest' }, { user_id: 'bob', name: 'Bob', avatar: 'https://example.com/b.png' }]
		});
		const general = () => snapshot.rooms.find((room) => room.id === 'general')!;
		expect(general().members?.map((member) => member.user_id)).toEqual(['guest_1', 'bob']);
		expect(general().memberCount).toBe(2);
		expect(general().membersAsOf).toBe('12');
		expect(snapshot.users.bob.avatar).toBe('https://example.com/b.png');
		// Joins and leaves keep the members current, and draw nothing.
		socket.receive({ method: 'user', params: { room_id: 'general', new: { user_id: 'carol', name: 'Carol' } } });
		expect(general().members?.map((member) => member.user_id)).toEqual(['guest_1', 'bob', 'carol']);
		expect(general().memberCount).toBe(3);
		expect(snapshot.users.carol.name).toBe('Carol');
		socket.receive({ method: 'user', params: { room_id: 'general', old: { user_id: 'bob' } } });
		expect(general().members?.map((member) => member.user_id)).toEqual(['guest_1', 'carol']);
		expect(general().memberCount).toBe(2);
		expect(snapshot.users.bob.name).toBe('Bob');
		expect(general().timeline.order).toEqual([]);
	});

	it('shares a room_list in flight and reuses a recent one', async () => {
		await connect();
		const listings = () => socket.sent.filter((frame) => frame.method === 'room_list').length;
		const before = listings();
		const first = client.listRooms();
		const second = client.listRooms();
		expect(listings() - before).toBe(1);
		await socket.reply('room_list', { rooms: [{ room_id: 'ops', log_id: '11' }] });
		expect((await first).map((room) => room.id)).toEqual(['ops']);
		expect((await second).map((room) => room.id)).toEqual(['ops']);
		quiet(client.listRooms());
		expect(listings() - before).toBe(1);
		// A caller that wants fresher, or any caller once it is stale, lists again.
		vi.advanceTimersByTime(5_000);
		quiet(client.listRooms(undefined, 1_000));
		expect(listings() - before).toBe(2);
		await socket.reply('room_list', { rooms: [] });
		vi.advanceTimersByTime(10_000);
		quiet(client.listRooms());
		expect(listings() - before).toBe(3);
		await socket.reply('room_list', { rooms: [{ room_id: 'ops', log_id: '11' }] });
		// An update to a room already joined changes nothing; joining one makes it stale.
		socket.receive({ method: 'room_update', params: { updated: [{ room_id: 'general', log_id: '10', title: 'General' }] } });
		quiet(client.listRooms());
		expect(listings() - before).toBe(3);
		socket.receive({ method: 'room_update', params: { joined: [{ room_id: 'ops', log_id: '11', title: 'Ops' }] } });
		quiet(client.listRooms());
		expect(listings() - before).toBe(4);
		await socket.reply('room_list', { rooms: [] });
		// So does leaving one.
		socket.receive({ method: 'room_update', params: { left: [{ room_id: 'ops' }] } });
		quiet(client.listRooms());
		expect(listings() - before).toBe(5);
	});

	it('updates the profile with me and adopts what the server kept', async () => {
		await connect();
		const saved = client.updateProfile({ avatar: '' });
		expect(socket.request('me').params).toEqual({ avatar: '' });
		await socket.reply('me', { you: { user_id: 'guest_1', name: 'Guest' } });
		await expect(saved).resolves.toEqual({ user_id: 'guest_1', name: 'Guest' });
	});

	it('sends files as upload embeds and writes each to its write_url', async () => {
		await connect();
		const writes: Array<{ url: string; body: unknown }> = [];
		vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
			writes.push({ url, body: init.body });
			return new Response(null, { status: 201 });
		}));
		const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
		const { sent, uploaded } = client.sendFiles('general', 'see attached', [file]);
		expect(socket.request('message').params).toEqual({ room_id: 'general', body: { text: 'see attached', format: 'plain', embeds: [{ kind: 'upload', title: 'notes.txt' }] } });
		await socket.reply('message', { message_id: '50', embeds: [{ embed_id: 'embed_1', kind: 'upload', write_url: 'http://fake.test/write/abc' }] });
		await expect(sent).resolves.toMatchObject({ message_id: '50' });
		await uploaded;
		expect(writes).toEqual([{ url: 'http://fake.test/write/abc', body: file }]);
		expect(snapshot.uploads).toEqual({});
	});

	it('keeps a failed write visible until dismissed', async () => {
		await connect();
		vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 413 })));
		const { uploaded } = client.sendFiles('general', '', [new File(['x'], 'big.bin')]);
		await socket.reply('message', { message_id: '51', embeds: [{ embed_id: 'embed_2', kind: 'upload', write_url: 'http://fake.test/write/x' }] });
		await expect(uploaded).rejects.toThrow(/larger than this server accepts/);
		expect(snapshot.uploads.embed_2).toMatchObject({ name: 'big.bin', failed: expect.stringMatching(/larger/) });
		client.dismissUpload('embed_2');
		expect(snapshot.uploads).toEqual({});
	});

	it('shows an unlogged @server notice and still recovers the room after a reconnect', async () => {
		await connect();
		// A notice takes a log_id past the room's logged head and never appears in history.
		socket.receive({ method: 'message', params: { message_id: '15', log_id: '15', room_id: 'general', from: { user_id: '@server', name: 'Server' }, body: { text: 'Typing updates are limited', format: 'plain' } } });
		const general = () => snapshot.rooms.find((room) => room.id === 'general')!;
		expect(general().timeline.order).toContain('15');
		socket.drop();
		client.retryNow();
		socket = FakeSocket.latest();
		await socket.greet(['history', 'rooms', 'activity'], { room: { room_id: 'general', log_id: '10', title: 'General', latest_log_id: '12', history_log_id: '10' } });
		await settle();
		const history = socket.request('history');
		await socket.reply('history', { entries: [{ message_id: '12', log_id: '12', room_id: 'general', from: { user_id: 'bob', name: 'Bob' }, body: { text: 'hi' } }], more: false, latest_log_id: '12', history_log_id: '10' });
		await settle();
		// One page settles it: no loop chasing the notice's log_id.
		expect(socket.sent.filter((frame) => frame.method === 'history')).toHaveLength(1);
		expect(history.params.room_id).toBe('general');
		expect(general().timeline.order).toContain('12');
	});

	it('uploads an avatar with a /avatar command carrying one upload embed', async () => {
		await connect(['history', 'rooms', 'embed:upload', 'command']);
		const writes: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (url: string) => {
			writes.push(url);
			return new Response(null, { status: 201 });
		}));
		const done = client.uploadAvatar(new File(['png'], 'me.png', { type: 'image/png' }));
		expect(socket.request('command').params).toEqual({ body: { text: '/avatar', embeds: [{ kind: 'upload', title: 'me.png' }] } });
		expect(socket.sent.some((frame) => frame.method === 'message')).toBe(false);
		await socket.reply('command', { embeds: [{ embed_id: 'embed_3', kind: 'upload', write_url: 'http://fake.test/write/av' }] });
		await done;
		expect(writes).toEqual(['http://fake.test/write/av']);
		// The server then sends `user`, which carries the avatar.
		socket.receive({ method: 'user', params: { you: { user_id: 'guest_1', avatar: 'https://fake.test/f/av' } } });
		expect(snapshot.you?.avatar).toBe('https://fake.test/f/av');
	});
});

describe('embed URL policy', () => {
	it('loads media only from the chat server and links only over http(s)', () => {
		const origin = serverOrigin('wss://chat.example/ws');
		expect(origin).toBe('https://chat.example');
		expect(serverOrigin('ws://localhost:5173/ws')).toBe('http://localhost:5173');
		expect(sameOriginMedia('https://chat.example/files/embed_1/s', origin)).toBe('https://chat.example/files/embed_1/s');
		expect(sameOriginMedia('https://elsewhere.example/x.png', origin)).toBeUndefined();
		expect(sameOriginMedia('data:image/png;base64,iVBORw0KGgo=', origin)).toBe('data:image/png;base64,iVBORw0KGgo=');
		expect(sameOriginMedia('data:text/html;base64,PGI+', origin)).toBeUndefined();
		expect(safeLink('javascript:alert(1)')).toBeUndefined();
		expect(safeLink('https://example.com/a')).toBe('https://example.com/a');
		expect(safeAvatar('https://gravatar.example/a.png', origin)).toBe('https://gravatar.example/a.png');
		expect(safeAvatar('http://elsewhere.example/a.png', origin)).toBeUndefined();
	});
});
