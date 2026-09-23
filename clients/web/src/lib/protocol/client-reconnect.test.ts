import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, type ClientSnapshot } from './client';
import { FakeSocket } from './fake-socket';

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
		// Rooms and identity are rebuilt from the next connection's announcements
		// (PROTOCOL.md §3.4); the UI holds its own copy meanwhile.
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

	it('bounds typing traffic while refreshing it before expiry', () => {
		const socket = latest();
		const typing = () => socket.sent.filter(frame => frame.method === 'typing');
		// Twenty seconds of keystrokes: one frame at the start and one refresh twelve seconds in.
		for (let key = 0; key < 200; key++) {
			client.sendTyping('lobby', true);
			vi.advanceTimersByTime(100);
		}
		expect(typing()).toHaveLength(2);
		expect(typing()[0].params).toMatchObject({ active: true, timeout: 15 });
		client.sendTyping('lobby', false);
		client.sendTyping('lobby', false);
		expect(typing()).toHaveLength(3);
		expect(typing().at(-1)?.params).toMatchObject({ active: false });
		client.sendTyping('lobby', true);
		expect(typing()).toHaveLength(4);
	});

	it('keeps typing refreshes independent across rooms and transport reconnects', async () => {
		client.sendTyping('lobby', true);
		client.sendTyping('another-room', true);
		expect(latest().sent.filter(frame => frame.method === 'typing')).toHaveLength(2);
		latest().drop();
		client.retryNow();
		await latest().greet();
		client.sendTyping('lobby', true);
		expect(latest().sent.filter(frame => frame.method === 'typing')).toHaveLength(1);
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
		latest().receive({ method: 'server', params: { protocol: 3, auth: ['webauthn', 'token', 'guest'], caps: [] } });
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
		latest().receive({ method: 'server', params: { protocol: 3, auth: ['webauthn', 'token', 'guest'], caps: [] } });
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
		await latest().reply('history', { entries: [entry('11'), entry('12')], more: false, latest_log_id: '12', history_log_id: '10' });
		expect(snapshot.rooms[0].recovering).toBe(false);
		expect(snapshot.showReconnectDivider).toBe(false);
		// A thread's first load is not a reconnect either.
		latest().receive({ method: 'room', params: { room_id: '20', log_id: '20', parent_room_id: 'general', title: 'Side', latest_log_id: '21', history_log_id: '20' } });
		const load = client.loadRoom('20');
		await latest().reply('history', { entries: [{ ...entry('21'), room_id: '20' }], more: false, latest_log_id: '21', history_log_id: '20' });
		await load;
		expect(snapshot.showReconnectDivider).toBe(false);

		latest().drop();
		vi.advanceTimersByTime(5_000);
		await latest().greet(['history', 'rooms'], { room });
		await latest().reply('history', { entries: [entry('11'), entry('12')], more: false, latest_log_id: '12', history_log_id: '10' });
		expect(snapshot.authenticated).toBe(true);
		expect(snapshot.showReconnectDivider).toBe(false);
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
