import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, type ClientSnapshot } from './client';
import { FakeSocket, settle } from './fake-socket';

function latest(): FakeSocket {
	return FakeSocket.latest();
}

describe('transport reconnects', () => {
	let client: ChatClient;
	let snapshot: ClientSnapshot;

	beforeEach(async () => {
		vi.useFakeTimers();
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
		client = new ChatClient('ws://fake.test/');
		client.subscribe((next) => (snapshot = next));
		client.start();
		await latest().greet();
		latest().receive({
			method: 'message',
			params: { message_id: '1724803200001', log_id: '1724803200001', room_id: 'lobby', from: { user_id: 'guest_1' }, body: { text: 'hi' } }
		});
		expect(snapshot.status).toBe('connected');
		expect(snapshot.authenticated).toBe(true);
	});

	afterEach(() => {
		client.stop();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('clears the protocol view on a drop and records when it happened', async () => {
		const dropped = Date.now();
		latest().drop();

		expect(snapshot.status).toBe('reconnecting');
		expect(snapshot.authenticated).toBe(false);
		expect(snapshot.disconnectedAt).toBe(dropped);
		// Rooms and identity are rebuilt from the next connection's room_list
		// (PROTOCOL.md §4.3.1); the UI holds its own copy meanwhile.
		expect(snapshot.rooms).toEqual([]);
		expect(snapshot.you).toBeUndefined();
		expect(snapshot.server).toBeUndefined();

		vi.advanceTimersByTime(5_000);
		expect(FakeSocket.instances).toHaveLength(2);
		// The backoff timer keeps disconnectedAt anchored to the original drop.
		expect(snapshot.disconnectedAt).toBe(dropped);

		latest().open();
		expect(snapshot.status).toBe('connected');
		expect(snapshot.authenticated).toBe(false);
		expect(snapshot.disconnectedAt).toBe(dropped);

		await latest().greet();
		expect(snapshot.status).toBe('connected');
		expect(snapshot.authenticated).toBe(true);
		expect(snapshot.disconnectedAt).toBeUndefined();
		expect(snapshot.rooms.map((room) => room.id)).toEqual(['lobby']);
		expect(snapshot.activeRoom).toBe('lobby');
	});

	it('retryNow skips the backoff and reconnects immediately', async () => {
		latest().drop();
		expect(FakeSocket.instances).toHaveLength(1);
		vi.advanceTimersByTime(50);
		client.retryNow();
		expect(FakeSocket.instances).toHaveLength(2);
		expect(snapshot.disconnectedAt).toBeDefined();

		// A retry while an attempt is stuck opening drops that attempt and opens another.
		client.retryNow();
		expect(FakeSocket.instances).toHaveLength(3);
		expect(FakeSocket.instances[1].readyState).toBe(FakeSocket.CLOSED);

		await latest().greet();
		expect(snapshot.status).toBe('connected');
		expect(snapshot.disconnectedAt).toBeUndefined();
	});

	it('does not reconnect or mark a disconnect after an explicit stop', () => {
		client.stop();
		expect(snapshot.status).toBe('offline');
		expect(snapshot.disconnectedAt).toBeUndefined();
		vi.advanceTimersByTime(60_000);
		expect(FakeSocket.instances).toHaveLength(1);
	});

	/** Replaces the server frame, advertising cap `activity`. */
	function advertiseActivity(socket = latest()): void {
		socket.receive({ method: 'server', params: { protocol: 4, name: 'fake', auth: ['guest'], caps: ['activity'] } });
	}

	it('bounds typing traffic while refreshing it before expiry', () => {
		const socket = latest();
		advertiseActivity();
		const typing = () => socket.sent.filter(frame => frame.method === 'activity');
		// Twenty seconds of keystrokes: one frame at the start and one refresh twelve seconds in.
		for (let key = 0; key < 200; key++) {
			client.sendTyping('lobby', true);
			vi.advanceTimersByTime(100);
		}
		expect(typing()).toHaveLength(2);
		expect(typing()[0]).toEqual({ method: 'activity', params: { room_id: 'lobby', typing: 15 } });
		client.sendTyping('lobby', false);
		client.sendTyping('lobby', false);
		expect(typing()).toHaveLength(3);
		expect(typing().at(-1)?.params).toEqual({ room_id: 'lobby', typing: 0 });
		client.sendTyping('lobby', true);
		expect(typing()).toHaveLength(4);
	});

	it('lets a sent message end typing without another activity frame', () => {
		const socket = latest();
		advertiseActivity();
		client.sendTyping('lobby', true);
		client.send('lobby', 'hello').promise.catch(() => undefined);
		client.sendTyping('lobby', false);
		const typing = socket.sent.filter(frame => frame.method === 'activity');
		expect(typing).toEqual([{ method: 'activity', params: { room_id: 'lobby', typing: 15 } }]);
	});

	it('sends no typing to a server without cap activity', () => {
		client.sendTyping('lobby', true);
		client.sendTyping('lobby', false);
		expect(latest().sent.filter(frame => frame.method === 'activity' || frame.method === 'typing')).toEqual([]);
	});

	it('keeps typing refreshes independent across rooms and transport reconnects', async () => {
		advertiseActivity();
		client.sendTyping('lobby', true);
		client.sendTyping('another-room', true);
		expect(latest().sent.filter(frame => frame.method === 'activity')).toHaveLength(2);
		latest().drop();
		client.retryNow();
		await latest().greet(['activity']);
		client.sendTyping('lobby', true);
		expect(latest().sent.filter(frame => frame.method === 'activity')).toHaveLength(1);
	});

	it('shows typing from activity broadcasts for the given seconds', () => {
		const bob = { user_id: 'bob', name: 'Bob' };
		const activity = (params: Record<string, unknown>) => latest().receive({ method: 'activity', params: { room_id: 'lobby', from: bob, ...params } });
		activity({ typing: 8 });
		expect(snapshot.typing).toEqual([{ room: 'lobby', from: bob }]);
		// Absent fields leave the state unchanged; read markers are not used.
		vi.advanceTimersByTime(5_000);
		activity({ read_message_id: '1724803200001' });
		expect(snapshot.typing).toEqual([{ room: 'lobby', from: bob }]);
		vi.advanceTimersByTime(3_000);
		expect(snapshot.typing).toEqual([]);
		// A refresh restarts the countdown; `typing: 0` stops at once.
		activity({ typing: 8 });
		vi.advanceTimersByTime(7_000);
		activity({ typing: 8 });
		vi.advanceTimersByTime(7_000);
		expect(snapshot.typing).toHaveLength(1);
		activity({ typing: 0 });
		expect(snapshot.typing).toEqual([]);
		// The old `typing` method is not a typing indicator any more.
		latest().receive({ method: 'typing', params: { room_id: 'lobby', from: bob, active: true } });
		expect(snapshot.typing).toEqual([]);
	});

	it('ends a typing indicator when a new message from that user arrives in the room', () => {
		const bob = { user_id: 'bob', name: 'Bob' };
		latest().receive({ method: 'activity', params: { room_id: 'lobby', from: bob, typing: 15 } });
		latest().receive({ method: 'activity', params: { room_id: 'lobby', from: { user_id: 'carol' }, typing: 15 } });
		// An edit is not a new message.
		latest().receive({ method: 'message', params: { message_id: '1724803200001', log_id: '1724803200002', room_id: 'lobby', from: bob, body: { text: 'edit' } } });
		expect(snapshot.typing.map((entry) => entry.from.user_id)).toEqual(['bob', 'carol']);
		latest().receive({ method: 'message', params: { message_id: '1724803200003', log_id: '1724803200003', room_id: 'lobby', from: bob, body: { text: 'done' } } });
		expect(snapshot.typing.map((entry) => entry.from.user_id)).toEqual(['carol']);
	});
});

describe('connection errors', () => {
	let client: ChatClient;
	let snapshot: ClientSnapshot;

	beforeEach(async () => {
		vi.useFakeTimers();
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
		client = new ChatClient('ws://fake.test/');
		client.subscribe((next) => (snapshot = next));
		client.start();
		await latest().greet();
	});

	afterEach(() => {
		client.stop();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('waits out retry_after before reconnecting', async () => {
		const pending = client.send('lobby', 'hello');
		pending.promise.catch(() => undefined);
		latest().receive({ error: { code: -32002, message: 'Server at capacity', data: { retry_after: 30 } } });
		// An error without `id` answers no request.
		expect(snapshot.pending).toHaveLength(1);
		expect(snapshot.error).toBe('Server at capacity');
		expect(snapshot.retryAfterMs).toBe(30_000);
		latest().drop();
		expect(snapshot.error).toBe('Server at capacity');
		vi.advanceTimersByTime(29_999);
		expect(FakeSocket.instances).toHaveLength(1);
		// A manual retry cannot skip the window either.
		client.retryNow();
		expect(FakeSocket.instances).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(FakeSocket.instances).toHaveLength(2);
		await latest().greet();
		expect(snapshot.authenticated).toBe(true);
		expect(snapshot.retryAfterMs).toBeUndefined();
	});

	it('does not reconnect after denied until the user retries', async () => {
		latest().receive({ error: { code: -32001, message: 'Session expired; sign in again' } });
		latest().onerror?.();
		latest().drop();
		expect(snapshot.status).toBe('reconnecting');
		expect(snapshot.error).toBe('Session expired; sign in again');
		vi.advanceTimersByTime(10 * 60_000);
		expect(FakeSocket.instances).toHaveLength(1);
		client.retryNow();
		expect(FakeSocket.instances).toHaveLength(2);
		expect(snapshot.error).toBeUndefined();
		await latest().greet();
		expect(snapshot.authenticated).toBe(true);
		// Later drops reconnect automatically again.
		latest().drop();
		vi.advanceTimersByTime(5_000);
		expect(FakeSocket.instances).toHaveLength(3);
	});

	it('treats a frame with a method and no id as a notification', () => {
		latest().receive({ method: 'room_update', params: { joined: [{ room_id: 'other', title: 'Other' }] }, error: { code: -32001, message: 'ignored' } });
		expect(snapshot.rooms.map((room) => room.id)).toEqual(['lobby', 'other']);
		expect(snapshot.error).toBeUndefined();
	});
});

describe('persisted session tokens', () => {
	const storage = new Map<string, string>();
	const fakeLocalStorage = {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, value),
		removeItem: (key: string) => void storage.delete(key)
	};
	let snapshot: ClientSnapshot;

	beforeEach(() => {
		vi.useFakeTimers();
		storage.clear();
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
		vi.stubGlobal('localStorage', fakeLocalStorage);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	function authParams(): Record<string, unknown> {
		const auth = latest().sent.find((frame) => frame.method === 'auth');
		if (!auth) throw new Error('client did not authenticate');
		return auth.params as Record<string, unknown>;
	}

	it('stores a token the server can resume with, keyed by server URL, and presents it on the next start', async () => {
		const first = new ChatClient('ws://fake.test/');
		first.subscribe((next) => (snapshot = next));
		first.start();
		await latest().greet([], { auth: ['webauthn', 'token', 'guest'], token: 'session-1' });
		expect(authParams()).toEqual(expect.objectContaining({ scheme: 'guest' }));
		expect(storage.get('apron.session:ws://fake.test/')).toBe('session-1');
		first.stop();

		const second = new ChatClient('ws://fake.test/');
		second.subscribe((next) => (snapshot = next));
		second.start();
		await latest().greet([], { auth: ['webauthn', 'token', 'guest'], token: 'session-1' });
		expect(authParams()).toEqual(expect.objectContaining({ scheme: 'token', token: 'session-1' }));
		expect(snapshot.passkeySession).toBe(true);
		second.stop();

		// Another server URL has its own entry.
		const elsewhere = new ChatClient('ws://other.test/');
		elsewhere.start();
		latest().open();
		latest().receive({ method: 'server', params: { protocol: 4, auth: ['webauthn', 'token', 'guest'], caps: [] } });
		expect(authParams()).toEqual(expect.objectContaining({ scheme: 'guest' }));
		elsewhere.stop();
	});

	it('does not persist a token when the server cannot resume with it', async () => {
		const client = new ChatClient('ws://fake.test/');
		client.start();
		await latest().greet([], { auth: ['webauthn', 'guest'], token: 'session-2' });
		expect(storage.has('apron.session:ws://fake.test/')).toBe(false);
		client.stop();
	});

	it('forgets a stored token the server rejects and on sign-out', async () => {
		storage.set('apron.session:ws://fake.test/', 'stale');
		const client = new ChatClient('ws://fake.test/');
		client.subscribe((next) => (snapshot = next));
		client.start();
		latest().open();
		latest().receive({ method: 'server', params: { protocol: 4, auth: ['webauthn', 'token', 'guest'], caps: [] } });
		const auth = latest().sent.find((frame) => frame.method === 'auth')!;
		expect(auth.params).toEqual(expect.objectContaining({ scheme: 'token', token: 'stale' }));
		latest().receive({ id: auth.id, error: { code: -32001, message: 'Session expired; sign in with your passkey' } });
		await Promise.resolve();
		await Promise.resolve();
		expect(storage.has('apron.session:ws://fake.test/')).toBe(false);
		expect(snapshot.error).toBe('Session expired; sign in with your passkey');
		expect(snapshot.authenticated).toBe(false);

		storage.set('apron.session:ws://fake.test/', 'fresh');
		const again = new ChatClient('ws://fake.test/');
		again.start();
		await latest().greet([], { auth: ['webauthn', 'token', 'guest'], token: 'fresh' });
		await again.signOut();
		expect(storage.has('apron.session:ws://fake.test/')).toBe(false);
		again.stop();
		client.stop();
	});
});

describe('failed handshake diagnostics', () => {
	let client: ChatClient;
	let snapshot: ClientSnapshot;
	const fetchStatus = vi.fn<typeof fetch>();

	beforeEach(() => {
		vi.useFakeTimers();
		FakeSocket.instances = [];
		fetchStatus.mockReset();
		vi.stubGlobal('fetch', fetchStatus);
		vi.stubGlobal('WebSocket', FakeSocket);
		client = new ChatClient('wss://server.test/ws');
		client.subscribe(next => { snapshot = next; });
		client.start();
	});

	afterEach(() => {
		client.stop();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('surfaces capacity errors and honors Retry-After, including manual retry', async () => {
		fetchStatus.mockResolvedValue(Response.json({ error: 'Daily demo capacity reached' }, {
			status: 429, headers: { 'Retry-After': '3600' }
		}));
		latest().drop();
		await vi.advanceTimersByTimeAsync(0);
		expect(String(fetchStatus.mock.calls[0][0])).toBe('https://server.test/ws?apron_connection_status=1');
		expect(fetchStatus.mock.calls[0][1]).toMatchObject({ credentials: 'omit', cache: 'no-store' });
		expect(snapshot.error).toBe('Daily demo capacity reached');
		expect(snapshot.retryAfterMs).toBe(3600000);
		client.retryNow();
		await vi.advanceTimersByTimeAsync(3599999);
		expect(FakeSocket.instances).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(FakeSocket.instances).toHaveLength(2);
	});

	it('falls back to reconnecting when diagnostics are unsupported', async () => {
		fetchStatus.mockResolvedValue(new Response('Not found', { status: 404 }));
		latest().drop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(FakeSocket.instances).toHaveLength(2);
	});

	it('ignores diagnostics from a server that was replaced', async () => {
		let resolve!: (response: Response) => void;
		fetchStatus.mockReturnValue(new Promise(done => { resolve = done; }));
		latest().drop();
		client.setUrl('wss://other.test/');
		resolve(Response.json({ error: 'Old capacity error' }, { status: 429, headers: { 'Retry-After': '86400' } }));
		await vi.advanceTimersByTimeAsync(0);
		expect(latest().url).toBe('wss://other.test/');
		expect(snapshot.error).toBeUndefined();
		expect(snapshot.retryAfterMs).toBeUndefined();
	});

	it('times out an unavailable diagnostic service and resumes retries', async () => {
		fetchStatus.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
			options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
		}));
		latest().drop();
		await vi.advanceTimersByTimeAsync(4000);
		expect(FakeSocket.instances).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(5000);
		expect(FakeSocket.instances).toHaveLength(2);
	});
});

describe('reconnect divider', () => {
	let client: ChatClient;
	let snapshot: ClientSnapshot;
	const room = { room_id: 'general', log_id: '10', title: 'General', latest_log_id: '12', history_log_id: '10' };
	const entry = (id: string) => ({ message_id: id, log_id: id, room_id: 'general', from: { user_id: 'guest_1' }, body: { text: id } });

	beforeEach(() => {
		vi.useFakeTimers();
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
		client = new ChatClient('ws://fake.test/');
		client.subscribe((next) => (snapshot = next));
		client.start();
	});

	afterEach(() => {
		client.stop();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('never marks a first load, or a reconnect that history fully recovers', async () => {
		await latest().greet(['history', 'rooms'], { room });
		expect(snapshot.showReconnectDivider).toBe(false);
		await latest().reply('history', { messages: [entry('11'), entry('12')], more: false, latest_log_id: '12', history_log_id: '10' });
		expect(snapshot.rooms[0].recovering).toBe(false);
		expect(snapshot.showReconnectDivider).toBe(false);
		// A thread's first load is not a reconnect either.
		latest().receive({ method: 'room_update', params: { joined: [{ room_id: '20', log_id: '20', parent_room_id: 'general', title: 'Side', latest_log_id: '21', history_log_id: '20' }] } });
		const load = client.loadRoom('20');
		await latest().reply('history', { messages: [{ ...entry('21'), room_id: '20' }], more: false, latest_log_id: '21', history_log_id: '20' });
		await load;
		expect(snapshot.showReconnectDivider).toBe(false);

		latest().drop();
		vi.advanceTimersByTime(5_000);
		await latest().greet(['history', 'rooms'], { room });
		// The kept room resumed right behind auth, from its checkpoint; one empty page settles it.
		expect(latest().sent.filter((frame) => frame.method === 'history').map((frame) => frame.params)).toEqual([{ room_id: 'general', after: '13', limit: 200 }]);
		await latest().reply('history', { more: false, latest_log_id: '12', history_log_id: '10' });
		expect(snapshot.rooms.find((candidate) => candidate.id === 'general')?.timeline.order).toEqual(['11', '12']);
		expect(snapshot.rooms.find((candidate) => candidate.id === 'general')?.recovering).toBe(false);
		expect(snapshot.authenticated).toBe(true);
		expect(snapshot.showReconnectDivider).toBe(false);
	});

	it('resumes a room from its checkpoint after a reconnect instead of paging all history', async () => {
		await latest().greet(['history', 'rooms'], { room });
		await latest().reply('history', { messages: [entry('11'), entry('12')], more: false, latest_log_id: '12', history_log_id: '10' });
		latest().drop();
		vi.advanceTimersByTime(5_000);
		await latest().greet(['history', 'rooms'], { room: { ...room, latest_log_id: '14' } });
		// Sent before the listing named a head: it pages to the end of the log, whose head the page reports.
		expect(latest().request('history').params).toEqual({ room_id: 'general', after: '13', limit: 200 });
		await latest().reply('history', { messages: [entry('13')], first_log_id: '13', last_log_id: '13', more: true, latest_log_id: '14', history_log_id: '10' });
		expect(latest().request('history').params).toEqual({ room_id: 'general', after: '14', before: '14', limit: 200 });
		await latest().reply('history', { messages: [entry('14')], first_log_id: '14', last_log_id: '14', more: false, latest_log_id: '14', history_log_id: '10' });
		expect(snapshot.rooms.find((candidate) => candidate.id === 'general')?.timeline.order).toEqual(['11', '12', '13', '14']);
		expect(snapshot.showReconnectDivider).toBe(false);
	});

	it('rebuilds a kept room when retention has passed its checkpoint', async () => {
		await latest().greet(['history', 'rooms'], { room });
		await latest().reply('history', { messages: [entry('11'), entry('12')], more: false, latest_log_id: '12', history_log_id: '10' });
		latest().drop();
		vi.advanceTimersByTime(5_000);
		await latest().greet(['history', 'rooms'], { room: { ...room, latest_log_id: '30', history_log_id: '20' } });
		expect(latest().request('history').params).toMatchObject({ room_id: 'general', after: '20', before: '30' });
		await latest().reply('history', { messages: [entry('25')], more: false, latest_log_id: '30', history_log_id: '20' });
		expect(snapshot.rooms.find((candidate) => candidate.id === 'general')?.timeline.order).toEqual(['25']);
	});

	it('catches a kept thread up from its checkpoint when it is loaded again', async () => {
		await latest().greet(['history', 'rooms'], { room });
		await latest().reply('history', { messages: [entry('11'), entry('12')], more: false, latest_log_id: '12', history_log_id: '10' });
		const thread = { room_id: '20', log_id: '20', parent_room_id: 'general', title: 'Side', latest_log_id: '21', history_log_id: '20' };
		latest().receive({ method: 'room_update', params: { joined: [thread] } });
		const load = client.loadRoom('20');
		await latest().reply('history', { messages: [{ ...entry('21'), room_id: '20' }], more: false, latest_log_id: '21', history_log_id: '20' });
		await load;
		latest().drop();
		vi.advanceTimersByTime(5_000);
		await latest().greet(['history', 'rooms'], { room });
		latest().receive({ method: 'room_update', params: { joined: [{ ...thread, latest_log_id: '23' }] } });
		// Kept, but the gap since its checkpoint is not loaded yet.
		expect(snapshot.rooms.find((candidate) => candidate.id === '20')?.loaded).toBe(false);
		const again = client.loadRoom('20');
		expect(latest().request('history').params).toMatchObject({ room_id: '20', after: '22', before: '23' });
		await latest().reply('history', { messages: [{ ...entry('23'), room_id: '20' }], more: false, latest_log_id: '23', history_log_id: '20' });
		await again;
		const side = snapshot.rooms.find((candidate) => candidate.id === '20');
		expect(side?.loaded).toBe(true);
		expect(side?.timeline.order).toEqual(['21', '23']);
	});

	it('lists only what changed since the kept checkpoints when resuming the same identity', async () => {
		const ops = { room_id: 'ops', log_id: '30', title: 'Ops', latest_log_id: '32', history_log_id: '30' };
		const joinedRooms = () => snapshot.rooms.map((candidate) => candidate.id);
		// A registered session: the server hands a token, so the next connection resumes the identity.
		latest().open();
		latest().receive({ method: 'server', params: { protocol: 6, auth: ['guest', 'token'], caps: ['history', 'rooms'] } });
		await latest().reply('auth', { you: { user_id: 'ada', name: 'Ada' }, token: 'secret' });
		await latest().reply('room_list', { joined: [room, ops], users: [] });
		await latest().reply('history', { more: false, latest_log_id: '32', history_log_id: '30' });
		const generalPage = latest().sent.find((frame) => frame.method === 'history' && (frame.params as { room_id: string }).room_id === 'general')!;
		latest().receive({ id: generalPage.id, result: { messages: [entry('11'), entry('12')], more: false, latest_log_id: '12', history_log_id: '10' } });
		await settle();
		expect(joinedRooms()).toEqual(['general', 'ops']);

		latest().drop();
		vi.advanceTimersByTime(5_000);
		const socket = latest();
		socket.open();
		socket.receive({ method: 'server', params: { protocol: 6, auth: ['guest', 'token'], caps: ['history', 'rooms'] } });
		expect(socket.request('auth').params).toMatchObject({ scheme: 'token', token: 'secret' });
		// The least checkpoint of the kept rooms: everything up to it is here.
		expect(socket.request('room_list').params).toEqual({ filter: 'joined', members: true, latest_log_id: '12' });
		expect(socket.sent.filter((frame) => frame.method === 'history').map((frame) => (frame.params as { room_id: string }).room_id)).toEqual(['general', 'ops']);
		await socket.reply('auth', { you: { user_id: 'ada', name: 'Ada' } });
		expect(snapshot.rooms).toEqual([]);
		// Only general changed; ops was left meanwhile; a room joined since arrives in joined.
		await socket.reply('room_list', {
			joined: [{ ...room, latest_log_id: '40' }, { room_id: 'new', log_id: '41', title: 'New', latest_log_id: '41', history_log_id: '41' }],
			left: [{ room_id: 'ops' }], users: []
		});
		expect(joinedRooms()).toEqual(['general', 'new']);
		expect(snapshot.rooms.every((candidate) => candidate.joined)).toBe(true);
	});

	it('keeps every kept room the changes since leave out, and relists a new identity in full', async () => {
		latest().open();
		latest().receive({ method: 'server', params: { protocol: 6, auth: ['guest', 'token'], caps: ['history', 'rooms'] } });
		await latest().reply('auth', { you: { user_id: 'ada', name: 'Ada' }, token: 'secret' });
		await latest().reply('room_list', { joined: [room], users: [] });
		await latest().reply('history', { messages: [entry('11'), entry('12')], more: false, latest_log_id: '12', history_log_id: '10' });
		latest().drop();
		vi.advanceTimersByTime(5_000);
		let socket = latest();
		socket.open();
		socket.receive({ method: 'server', params: { protocol: 6, auth: ['guest', 'token'], caps: ['history', 'rooms'] } });
		await socket.reply('auth', { you: { user_id: 'ada', name: 'Ada' } });
		// Nothing changed: an empty listing with left keeps general as it was.
		await socket.reply('room_list', { joined: [], left: [], users: [] });
		expect(snapshot.rooms.map((candidate) => [candidate.id, candidate.joined])).toEqual([['general', true]]);
		await socket.reply('history', { more: false, latest_log_id: '12', history_log_id: '10' });
		expect(snapshot.rooms[0].timeline.order).toEqual(['11', '12']);

		// The token now signs in someone else: the changes since belong to another identity, so list again in full.
		socket.drop();
		vi.advanceTimersByTime(5_000);
		socket = latest();
		socket.open();
		socket.receive({ method: 'server', params: { protocol: 6, auth: ['guest', 'token'], caps: ['history', 'rooms'] } });
		expect(socket.request('room_list').params).toMatchObject({ latest_log_id: '12' });
		await socket.reply('auth', { you: { user_id: 'bob', name: 'Bob' } });
		const delta = socket.request('room_list');
		await socket.reply('room_list', { joined: [], left: [], users: [] });
		const full = socket.request('room_list');
		expect(full.id).not.toBe(delta.id);
		expect(full.params).toEqual({ filter: 'joined', members: true });
		// A result without left is a full listing: general is not Bob's.
		await socket.reply('room_list', { joined: [{ room_id: 'ops', log_id: '30', title: 'Ops', latest_log_id: '30', history_log_id: '30' }], users: [] });
		expect(snapshot.rooms.map((candidate) => candidate.id)).toEqual(['ops']);
	});

	it('marks a reconnect to a server without history, whose earlier messages are gone', async () => {
		await latest().greet();
		latest().receive({ method: 'message', params: { ...entry('11'), room_id: 'lobby' } });
		expect(snapshot.showReconnectDivider).toBe(false);
		latest().drop();
		vi.advanceTimersByTime(5_000);
		await latest().greet();
		expect(snapshot.authenticated).toBe(true);
		expect(snapshot.showReconnectDivider).toBe(true);
	});
});

describe('liveness pings', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	const pings = (socket: FakeSocket) => socket.sent.filter((frame) => frame.method === 'ping').length;

	it('pings with the exact bytes every server.ping seconds, before auth too, until the socket goes', async () => {
		const client = new ChatClient('ws://fake.test/');
		const raw: string[] = [];
		client.start();
		const first = latest();
		const send = first.send.bind(first);
		first.send = (data: string) => { raw.push(data); send(data); };
		first.open();
		first.receive({ method: 'server', params: { protocol: 6, auth: ['token'], caps: [], ping: 30 } });
		// No guest scheme and no token: the client never authenticates, and still pings (§1).
		expect(pings(first)).toBe(0);
		vi.advanceTimersByTime(30_000);
		expect(raw).toContain('{"method":"ping"}');
		expect(pings(first)).toBe(1);
		first.receive({ method: 'pong' });
		vi.advanceTimersByTime(30_000);
		expect(pings(first)).toBe(2);

		first.drop();
		vi.advanceTimersByTime(90_000);
		expect(pings(first)).toBe(2);
		client.stop();
		vi.advanceTimersByTime(90_000);
		expect(FakeSocket.instances.every((socket) => socket === first || pings(socket) === 0)).toBe(true);
	});

	it('replaces a socket whose ping goes a whole interval without a pong, and keeps one that answers', async () => {
		const client = new ChatClient('ws://fake.test/');
		let snapshot: ClientSnapshot | undefined;
		client.subscribe((next) => (snapshot = next));
		client.start();
		await latest().greet([], { ping: 30 });
		const first = latest();
		// Answered: the connection stays.
		for (let tick = 0; tick < 4; tick++) {
			vi.advanceTimersByTime(30_000);
			first.receive({ method: 'pong' });
		}
		expect(pings(first)).toBe(4);
		expect(snapshot?.status).toBe('connected');
		expect(FakeSocket.instances).toHaveLength(1);

		// The ping at 150s goes unanswered, and the tick at 180s drops the socket.
		vi.advanceTimersByTime(30_000);
		expect(snapshot?.status).toBe('connected');
		vi.advanceTimersByTime(30_000);
		expect(snapshot?.status).toBe('reconnecting');
		expect(first.readyState).toBe(FakeSocket.CLOSED);
		vi.advanceTimersByTime(5_000);
		expect(FakeSocket.instances).toHaveLength(2);
		client.stop();
	});

	it('probes again after its timers were frozen instead of dropping the socket', async () => {
		const client = new ChatClient('ws://fake.test/');
		let snapshot: ClientSnapshot | undefined;
		client.subscribe((next) => (snapshot = next));
		client.start();
		await latest().greet([], { ping: 30 });
		vi.advanceTimersByTime(30_000);
		latest().receive({ method: 'pong' });
		// A frozen tab's clock jumps without its interval firing in between.
		vi.setSystemTime(Date.now() + 10 * 60_000);
		vi.advanceTimersByTime(30_000);
		expect(snapshot?.status).toBe('connected');
		expect(pings(latest())).toBe(2);
		client.stop();
	});

	it('follows a replacing server frame to its new interval', async () => {
		const client = new ChatClient('ws://fake.test/');
		client.start();
		await latest().greet([], { ping: 30 });
		latest().receive({ method: 'server', params: { protocol: 6, auth: ['guest'], caps: ['rooms'], ping: 10 } });
		vi.advanceTimersByTime(10_000);
		expect(pings(latest())).toBe(1);
		latest().receive({ method: 'server', params: { protocol: 6, auth: ['guest'], caps: ['rooms'] } });
		vi.advanceTimersByTime(300_000);
		expect(pings(latest())).toBe(1);
		client.stop();
	});

	it('sends nothing to a server that does not ask', async () => {
		const client = new ChatClient('ws://fake.test/');
		client.start();
		await latest().greet();
		vi.advanceTimersByTime(300_000);
		expect(pings(latest())).toBe(0);
		client.stop();
	});
});

describe('display name on connect', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	const renames = (socket: FakeSocket) => socket.sent.filter((frame) => frame.method === 'me').length;

	it('skips a name the server already has', async () => {
		const client = new ChatClient('ws://fake.test/', 'Guest');
		client.start();
		// greet() authenticates as { user_id: 'guest_1', name: 'Guest' }.
		await latest().greet();
		expect(renames(latest())).toBe(0);
		client.stop();
	});

	it('does not resend a name the server denied after a reconnect', async () => {
		const client = new ChatClient('ws://fake.test/', 'Dana');
		client.start();
		await latest().greet();
		const first = latest();
		expect(renames(first)).toBe(1);
		first.receive({ id: first.request('me').id, error: { code: -32001, message: 'Only registered users may change their name' } });
		await Promise.resolve();
		first.drop();
		vi.advanceTimersByTime(5_000);
		await latest().greet();
		expect(latest()).not.toBe(first);
		expect(renames(latest())).toBe(0);
		// Choosing a new name sends it again.
		client.setDisplayName('Dee');
		expect(renames(latest())).toBe(1);
		client.stop();
	});
});

describe('reconnect damping', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('keeps backing off when connections close right after auth', async () => {
		// No jitter: the delays are exactly 0.5 s, 1 s, 2 s.
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const client = new ChatClient('ws://fake.test/');
		client.start();
		await latest().greet();
		// Each connection authenticates, then drops at once: the delay keeps growing.
		for (const delay of [500, 1_000, 2_000]) {
			latest().drop();
			const before = FakeSocket.instances.length;
			vi.advanceTimersByTime(delay - 1);
			expect(FakeSocket.instances).toHaveLength(before);
			vi.advanceTimersByTime(1);
			expect(FakeSocket.instances).toHaveLength(before + 1);
			await latest().greet();
		}
		// A connection that stays up resets it.
		vi.advanceTimersByTime(30_000);
		latest().drop();
		const before = FakeSocket.instances.length;
		vi.advanceTimersByTime(500);
		expect(FakeSocket.instances).toHaveLength(before + 1);
		client.stop();
		vi.restoreAllMocks();
	});

	it('waits for the page to be shown before connecting again', async () => {
		const listeners = new Map<string, () => void>();
		const page = { visibilityState: 'visible', addEventListener: (type: string, fn: () => void) => listeners.set(type, fn), removeEventListener: (type: string) => listeners.delete(type) };
		vi.stubGlobal('document', page);
		const client = new ChatClient('ws://fake.test/');
		client.start();
		await latest().greet();
		page.visibilityState = 'hidden';
		latest().drop();
		vi.advanceTimersByTime(120_000);
		expect(FakeSocket.instances).toHaveLength(1);
		page.visibilityState = 'visible';
		listeners.get('visibilitychange')?.();
		expect(FakeSocket.instances).toHaveLength(2);
		expect(listeners.has('visibilitychange')).toBe(false);
		client.stop();
	});

	it('does not open a first connection from a hidden page until it is shown', () => {
		const listeners = new Map<string, () => void>();
		vi.stubGlobal('document', { visibilityState: 'hidden', addEventListener: (type: string, fn: () => void) => listeners.set(type, fn), removeEventListener: (type: string) => listeners.delete(type) });
		const client = new ChatClient('ws://fake.test/');
		client.start();
		expect(FakeSocket.instances).toHaveLength(0);
		(globalThis.document as unknown as { visibilityState: string }).visibilityState = 'visible';
		listeners.get('visibilitychange')?.();
		expect(FakeSocket.instances).toHaveLength(1);
		client.stop();
	});
});
