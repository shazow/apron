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
		await socket.reply('history', { more: false, latest_log_id: '10', history_log_id: '10' });
	}

	it('keeps one user object per user_id from current objects, field by field', async () => {
		await connect();
		expect(snapshot.users.guest_1).toEqual({ user_id: 'guest_1', name: 'Guest' });
		// A from is a recorded object: it never merges into the kept one (§3.3).
		socket.receive({ method: 'message', params: { message_id: '20', log_id: '20', room_id: 'general', from: { user_id: 'bob', name: 'Bob' }, body: { text: 'hi' } } });
		expect(snapshot.users.bob).toBeUndefined();
		expect(snapshot.recordedUsers.bob).toEqual({ user_id: 'bob', name: 'Bob' });
		// A present field replaces, a missing one is left alone.
		socket.receive({ method: 'user', params: { new: { user_id: 'bob', name: 'Bobby', avatar: 'https://example.com/b.png' } } });
		socket.receive({ method: 'message', params: { message_id: '21', log_id: '21', room_id: 'general', from: { user_id: 'bob', name: 'Robert' }, body: { text: 'hi' } } });
		expect(snapshot.users.bob).toEqual({ user_id: 'bob', name: 'Bobby', avatar: 'https://example.com/b.png' });
		// A bare object changes nothing; an empty value removes the field.
		socket.receive({ method: 'user', params: { new: { user_id: 'bob' } } });
		expect(snapshot.users.bob).toEqual({ user_id: 'bob', name: 'Bobby', avatar: 'https://example.com/b.png' });
		socket.receive({ method: 'user', params: { new: { user_id: 'bob', avatar: '', ext: {} } } });
		expect(snapshot.users.bob).toEqual({ user_id: 'bob', name: 'Bobby' });
		// The latest recorded object is kept apart, by log_id: an edit of an older message does not replace it.
		socket.receive({ method: 'message', params: { message_id: '20', log_id: '22', room_id: 'general', from: { user_id: 'bob', name: 'Bob' }, body: { text: 'edited' } } });
		expect(snapshot.recordedUsers.bob).toEqual({ user_id: 'bob', name: 'Bob' });
		// A user_id change aliases the old ID to the new identity; `old` itself is not merged.
		socket.receive({ method: 'user', params: { new: { user_id: 'ada', name: 'Ada' }, old: { user_id: 'guest_9', name: 'Guest 9' } } });
		expect(userIn(snapshot, { user_id: 'guest_9' })).toEqual({ user_id: 'ada', name: 'Ada' });
		expect(snapshot.users.guest_9).toBeUndefined();
		// `old` alone, or `user` with a room_id, says nothing about identity any more.
		socket.receive({ method: 'user', params: { old: { user_id: 'bob' } } });
		socket.receive({ method: 'user', params: { room_id: 'general', old: { user_id: 'bob' } } });
		expect(snapshot.users.bob).toEqual({ user_id: 'bob', name: 'Bobby' });
		// `you` merges into this connection's identity.
		socket.receive({ method: 'user', params: { you: { user_id: 'guest_1', avatar: 'https://example.com/me.png' } } });
		expect(snapshot.you).toEqual({ user_id: 'guest_1', name: 'Guest', avatar: 'https://example.com/me.png' });
		expect(snapshot.users.guest_1).toBe(snapshot.you);
	});

	it('renders a user field by field: the kept object, then the recorded one, then the user_id', async () => {
		await connect();
		const users = { users: { bob: { user_id: 'bob', avatar: 'https://example.com/b.png' } }, userAliases: {} };
		// The kept object has no name: the from's name shows, with the kept avatar.
		expect(userIn(users, { user_id: 'bob', name: 'Bob then' })).toEqual({ user_id: 'bob', name: 'Bob then', avatar: 'https://example.com/b.png' });
		// A kept object with every recorded field is returned as is.
		const kept = { user_id: 'carol', name: 'Carol' };
		expect(userIn({ users: { carol: kept }, userAliases: {} }, { user_id: 'carol', name: 'Caroline' })).toBe(kept);
		// Nothing kept: the recorded object alone.
		const from = { user_id: 'dana', name: 'Dana' };
		expect(userIn(users, from)).toBe(from);
	});

	it('ignores users in a history page and applies its memberships', async () => {
		await socket.greet(['history', 'rooms'], { room: { room_id: 'general', log_id: '10', title: 'General', latest_log_id: '13', history_log_id: '10' } });
		await socket.reply('history', {
			messages: [{ message_id: '11', log_id: '11', room_id: 'general', from: { user_id: 'bob', name: 'Bob then' }, body: { text: 'a' } }],
			membership: [{ log_id: '12', room_id: 'general', members: [{ user: { user_id: 'bob', name: 'Bob then' }, joined: true }, { user: { user_id: 'carol' }, joined: false }] }],
			users: [{ user_id: 'bob', name: 'Bob now' }],
			first_log_id: '11', last_log_id: '13', more: false, latest_log_id: '13', history_log_id: '10'
		});
		expect(snapshot.users.bob).toBeUndefined();
		expect(snapshot.recordedUsers.bob).toEqual({ user_id: 'bob', name: 'Bob then' });
		expect(snapshot.rooms[0].members?.map((member) => member.user_id)).toEqual(['bob']);
		// The timeline keeps the record at its log_id for join and leave lines, and a live one after it.
		expect(snapshot.rooms[0].timeline.memberships).toEqual([
			{ log_id: '12', entries: [{ user: { user_id: 'bob', name: 'Bob then' }, joined: true }, { user: { user_id: 'carol' }, joined: false }] }
		]);
		socket.receive({ method: 'membership', params: { log_id: '14', room_id: 'general', members: [{ user: { user_id: 'bob' }, joined: false }] } });
		expect(snapshot.rooms[0].timeline.memberships.map((record) => record.log_id)).toEqual(['12', '14']);
		expect(snapshot.rooms[0].members).toEqual([]);
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
		await socket.reply('history', { more: false, latest_log_id: '10', history_log_id: '10' });
		socket.sent = [];
		client.markRead('general', '31');
		expect(socket.sent).toEqual([]);
		expect(snapshot.rooms.find((room) => room.id === 'general')?.readMessageId).toBe('31');
	});

	it('lists rooms and threads to join, and one room with its members', async () => {
		await connect();
		const listing = client.listRooms();
		expect(socket.request('room_list').params).toEqual({ filter: 'not_joined', members: true });
		await socket.reply('room_list', {
			not_joined: [
				{ room_id: 'ops', log_id: '11', latest_log_id: '11', members: [{ user_id: 'bob' }, { user_id: 'carol' }, { user_id: 'dana' }] },
				{ room_id: 'general', log_id: '10', title: 'General', latest_log_id: '12', members: [] }
			],
			users: [{ user_id: 'bob', name: 'Bob' }, { user_id: 'carol', name: 'Carol' }, { user_id: 'dana', name: 'Dana' }]
		});
		const rooms = await listing;
		expect(rooms.map((room) => [room.id, room.title, room.joined, room.members.length])).toEqual([['ops', 'ops', false, 3], ['general', 'General', true, 0]]);
		expect(snapshot.directory?.map((room) => room.id)).toEqual(['ops', 'general']);
		expect(snapshot.users.carol).toEqual({ user_id: 'carol', name: 'Carol' });
		quiet(client.listRooms('general'));
		expect(socket.request('room_list').params).toEqual({ parent_room_id: 'general', filter: 'not_joined' });
		await socket.reply('room_list', { not_joined: [{ room_id: 't1', log_id: '13', parent_room_id: 'general', title: 'Thread' }] });
		expect(snapshot.threadDirectory.general.map((room) => room.id)).toEqual(['t1']);
		// Members come bare, with the complete objects in the result's users.
		quiet(client.listMembers('general'));
		expect(socket.request('room_list').params).toEqual({ room_id: 'general', members: true });
		await socket.reply('room_list', {
			joined: [{ room_id: 'general', log_id: '10', title: 'General', latest_log_id: '12', members: [{ user_id: 'bob' }, { user_id: 'guest_1' }] }],
			users: [{ user_id: 'bob', name: 'Bob', avatar: 'https://example.com/b.png' }, { user_id: 'guest_1', name: 'Guest' }]
		});
		const general = () => snapshot.rooms.find((room) => room.id === 'general')!;
		expect(general().members?.map((member) => member.user_id)).toEqual(['bob', 'guest_1']);
		expect(snapshot.users.bob.avatar).toBe('https://example.com/b.png');
		// Memberships keep the members current (§4.3.2), and draw nothing.
		socket.receive({ method: 'membership', params: { log_id: '13', room_id: 'general', members: [{ user: { user_id: 'carol', name: 'Carol' }, joined: true }] } });
		expect(general().members?.map((member) => member.user_id)).toEqual(['bob', 'guest_1', 'carol']);
		expect(general().latestLogId).toBe('13');
		socket.receive({ method: 'membership', params: { log_id: '14', room_id: 'general', members: [{ user: { user_id: 'bob' }, joined: false }] } });
		expect(general().members?.map((member) => member.user_id)).toEqual(['guest_1', 'carol']);
		// A membership at or below the listing's head is already in it; an older one for a user loses to a newer one.
		socket.receive({ method: 'membership', params: { log_id: '12', room_id: 'general', members: [{ user: { user_id: 'guest_1' }, joined: false }] } });
		socket.receive({ method: 'membership', params: { log_id: '13', room_id: 'general', members: [{ user: { user_id: 'bob' }, joined: true }] } });
		expect(general().members?.map((member) => member.user_id)).toEqual(['guest_1', 'carol']);
		// Recorded users never merge into the kept ones.
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
		await socket.reply('room_list', { not_joined: [{ room_id: 'ops', log_id: '11' }] });
		expect((await first).map((room) => room.id)).toEqual(['ops']);
		expect((await second).map((room) => room.id)).toEqual(['ops']);
		quiet(client.listRooms());
		expect(listings() - before).toBe(1);
		// A caller that wants fresher, or any caller once it is stale, lists again.
		vi.advanceTimersByTime(5_000);
		quiet(client.listRooms(undefined, 1_000));
		expect(listings() - before).toBe(2);
		await socket.reply('room_list', { not_joined: [] });
		vi.advanceTimersByTime(10_000);
		quiet(client.listRooms());
		expect(listings() - before).toBe(3);
		await socket.reply('room_list', { not_joined: [{ room_id: 'ops', log_id: '11' }] });
		// An update to a room already joined changes nothing; joining one makes it stale.
		socket.receive({ method: 'room_update', params: { updated: [{ room_id: 'general', log_id: '10', title: 'General' }] } });
		quiet(client.listRooms());
		expect(listings() - before).toBe(3);
		socket.receive({ method: 'room_update', params: { joined: [{ room_id: 'ops', log_id: '11', title: 'Ops' }] } });
		quiet(client.listRooms());
		expect(listings() - before).toBe(4);
		await socket.reply('room_list', { not_joined: [] });
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

	it('shows a logged @server notice and resumes the room right behind auth after a reconnect', async () => {
		await connect();
		// A notice takes a log_id past the room's logged head.
		socket.receive({ method: 'message', params: { message_id: '15', log_id: '15', room_id: 'general', from: { user_id: '@server', name: 'Server' }, body: { text: 'Typing updates are limited', format: 'plain' } } });
		const general = () => snapshot.rooms.find((room) => room.id === 'general')!;
		expect(general().timeline.order).toContain('15');
		socket.drop();
		client.retryNow();
		socket = FakeSocket.latest();
		socket.open();
		socket.receive({ method: 'server', params: { protocol: 6, auth: ['guest'], caps: ['history', 'rooms', 'activity'] } });
		// auth, the listing, and the kept room's recovery go out together, before any reply (§3.2).
		expect(socket.sent.map((frame) => frame.method)).toEqual(['auth', 'room_list', 'history']);
		expect(socket.request('room_list').params).toEqual({ filter: 'joined', members: true });
		// Without a head yet, it pages from the checkpoint to the end of the log.
		expect(socket.request('history').params).toEqual({ room_id: 'general', after: '11', limit: 200 });
		await socket.reply('auth', { you: { user_id: 'guest_2', name: 'Guest' } });
		await socket.reply('room_list', { joined: [{ room_id: 'general', log_id: '10', title: 'General', latest_log_id: '15', history_log_id: '10', members: [{ user_id: 'guest_2' }] }], users: [] });
		await socket.reply('history', { messages: [{ message_id: '12', log_id: '12', room_id: 'general', from: { user_id: 'bob', name: 'Bob' }, body: { text: 'hi' } }], first_log_id: '12', last_log_id: '15', more: false, latest_log_id: '15', history_log_id: '10' });
		// One page settles it.
		expect(socket.sent.filter((frame) => frame.method === 'history')).toHaveLength(1);
		expect(general().timeline.order).toEqual(['12', '15']);
		expect(general().members?.map((member) => member.user_id)).toEqual(['guest_2']);
		expect(general().recovering).toBe(false);
	});

	it('shows a server-wide notice for a room not joined where you are', async () => {
		await connect();
		socket.receive({ method: 'message', params: { message_id: '16', log_id: '16', room_id: 'elsewhere', from: { user_id: '@server', name: 'Server' }, body: { text: 'Maintenance at 17:00' } } });
		expect(snapshot.rooms.map((room) => room.id)).toEqual(['general']);
		expect(snapshot.rooms[0].notices.map((notice) => notice.body?.text)).toEqual(['Maintenance at 17:00']);
		expect(client.message('16')?.room_id).toBe('elsewhere');
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
