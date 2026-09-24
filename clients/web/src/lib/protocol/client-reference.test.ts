import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, AVATAR_ROOM, userIn, type ClientSnapshot } from './client';
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

	it('keeps the latest user object per user_id and follows renames', async () => {
		await connect();
		expect(snapshot.users.guest_1).toEqual({ user_id: 'guest_1', name: 'Guest' });
		socket.receive({ method: 'message', params: { message_id: '20', log_id: '20', room_id: 'general', from: { user_id: 'bob', name: 'Bob' }, body: { text: 'hi' } } });
		expect(snapshot.users.bob).toEqual({ user_id: 'bob', name: 'Bob' });
		// A profile carries the avatar; a later live from updates only the name.
		socket.receive({ method: 'user', params: { new: { user_id: 'bob', name: 'Bobby', avatar: 'https://example.com/b.png' } } });
		socket.receive({ method: 'message', params: { message_id: '21', log_id: '21', room_id: 'general', from: { user_id: 'bob', name: 'Robert' }, body: { text: 'hi' } } });
		expect(snapshot.users.bob).toEqual({ user_id: 'bob', name: 'Robert', avatar: 'https://example.com/b.png' });
		// An old snapshot never overwrites what is known.
		socket.receive({ method: 'message', params: { message_id: '22', log_id: '22', room_id: 'general', from: { user_id: 'carol', name: 'Carol' }, body: { text: 'hi' }, reply_to: { message_id: '19', log_id: '19', room_id: 'general', from: { user_id: 'bob', name: 'Old Bob' }, body: {} } } });
		expect(snapshot.users.bob.name).toBe('Robert');
		// A user_id change aliases the old ID to the new identity.
		socket.receive({ method: 'user', params: { new: { user_id: 'ada', name: 'Ada' }, old: { user_id: 'guest_9', name: 'Guest 9' } } });
		expect(userIn(snapshot, { user_id: 'guest_9' })).toEqual({ user_id: 'ada', name: 'Ada' });
		// `you` replaces this connection's identity.
		socket.receive({ method: 'user', params: { you: { user_id: 'guest_1', name: 'Renamed', avatar: 'https://example.com/me.png' } } });
		expect(snapshot.you).toEqual({ user_id: 'guest_1', name: 'Renamed', avatar: 'https://example.com/me.png' });
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

	it('lists rooms with members and marks the joined ones', async () => {
		await connect();
		const listing = client.listRooms();
		expect(socket.request('room_list').params).toEqual({});
		await socket.reply('room_list', { rooms: [
			{ room_id: 'general', log_id: '10', title: 'General', latest_log_id: '12', members: [{ user_id: 'guest_1', name: 'Guest' }, { user_id: 'bob', name: 'Bob', avatar: 'https://example.com/b.png' }] },
			{ room_id: 'ops', log_id: '11', latest_log_id: '11', members: [] }
		] });
		const rooms = await listing;
		expect(rooms.map((room) => [room.id, room.title, room.joined])).toEqual([['general', 'General', true], ['ops', 'ops', false]]);
		expect(snapshot.directory?.map((room) => room.id)).toEqual(['general', 'ops']);
		expect(snapshot.users.bob.avatar).toBe('https://example.com/b.png');
		expect(snapshot.rooms.find((room) => room.id === 'general')?.members?.map((member) => member.user_id)).toEqual(['guest_1', 'bob']);
		quiet(client.listRooms('general'));
		expect(socket.request('room_list').params).toEqual({ parent_room_id: 'general' });
		await socket.reply('room_list', { rooms: [{ room_id: 't1', log_id: '13', parent_room_id: 'general', title: 'Thread', members: [] }] });
		expect(snapshot.threadDirectory.general.map((room) => room.id)).toEqual(['t1']);
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

	it('uploads an avatar as a message to room @avatar', async () => {
		await connect();
		vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 201 })));
		const done = client.uploadAvatar(new File(['png'], 'me.png', { type: 'image/png' }));
		expect(socket.request('message').params).toEqual({ room_id: AVATAR_ROOM, body: { embeds: [{ kind: 'upload', title: 'me.png' }] } });
		await socket.reply('message', { message_id: '60', embeds: [{ embed_id: 'embed_3', kind: 'upload', write_url: 'http://fake.test/write/av' }] });
		await done;
		await settle();
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
