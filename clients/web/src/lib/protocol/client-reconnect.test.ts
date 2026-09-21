import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, type ClientSnapshot } from './client';

/**
 * Minimal scripted WebSocket. Frames the client sends are parsed into `sent`;
 * the test replies through `receive` and drops the transport with `drop`.
 */
class FakeSocket {
	static instances: FakeSocket[] = [];
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = FakeSocket.CONNECTING;
	sent: Array<Record<string, unknown>> = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;

	constructor(public url: string) {
		FakeSocket.instances.push(this);
	}

	send(data: string): void {
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
	}

	close(): void {
		this.readyState = FakeSocket.CLOSED;
	}

	open(): void {
		this.readyState = FakeSocket.OPEN;
		this.onopen?.();
	}

	receive(frame: Record<string, unknown>): void {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}

	drop(): void {
		this.readyState = FakeSocket.CLOSED;
		this.onclose?.();
	}

	/** Runs the greeting, answers the auth request, and announces one room. */
	async greet(caps: string[] = [], options: { auth?: string[]; token?: string } = {}): Promise<void> {
		this.open();
		this.receive({ method: 'server', params: { protocol: 1, name: 'fake', auth: options.auth ?? ['anonymous'], caps } });
		const auth = this.sent.find((frame) => frame.method === 'auth');
		if (!auth) throw new Error('client did not authenticate');
		this.receive({ id: auth.id, result: { you: { user_id: 'guest-1', name: 'Guest' }, ...(options.token ? { token: options.token } : {}) } });
		// The auth response settles through a promise before the client applies it.
		await Promise.resolve();
		await Promise.resolve();
		this.receive({ method: 'room', params: { room_id: 'lobby', name: 'Lobby' } });
	}
}

function latest(): FakeSocket {
	const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
	if (!socket) throw new Error('no socket has been opened');
	return socket;
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
			params: { room_id: 'lobby', log_id: '1724803200001', message: { message_id: '1724803200001', from: { user_id: 'guest-1' }, body: { text: 'hi' } } }
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
		for (let key = 0; key < 200; key++) {
			client.sendTyping('lobby', true);
			vi.advanceTimersByTime(100);
		}
		expect(typing()).toHaveLength(5);
		client.sendTyping('lobby', false);
		client.sendTyping('lobby', false);
		expect(typing()).toHaveLength(6);
		expect(typing().at(-1)?.params).toMatchObject({ active: false });
		client.sendTyping('lobby', true);
		expect(typing()).toHaveLength(7);
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
		await latest().greet([], { auth: ['webauthn', 'token', 'anonymous'], token: 'session-1' });
		expect(authParams()).toEqual(expect.objectContaining({ scheme: 'anonymous' }));
		expect(storage.get('bottomless.session:ws://fake.test/')).toBe('session-1');
		first.stop();

		const second = new ChatClient('ws://fake.test/');
		second.subscribe((next) => (snapshot = next));
		second.start();
		await latest().greet([], { auth: ['webauthn', 'token', 'anonymous'], token: 'session-1' });
		expect(authParams()).toEqual(expect.objectContaining({ scheme: 'token', token: 'session-1' }));
		expect(snapshot.passkeySession).toBe(true);
		second.stop();

		// Another server URL has its own entry.
		const elsewhere = new ChatClient('ws://other.test/');
		elsewhere.start();
		latest().open();
		latest().receive({ method: 'server', params: { protocol: 1, auth: ['webauthn', 'token', 'anonymous'], caps: [] } });
		expect(authParams()).toEqual(expect.objectContaining({ scheme: 'anonymous' }));
		elsewhere.stop();
	});

	it('does not persist a token when the server cannot resume with it', async () => {
		const client = new ChatClient('ws://fake.test/');
		client.start();
		await latest().greet([], { auth: ['webauthn', 'anonymous'], token: 'session-2' });
		expect(storage.has('bottomless.session:ws://fake.test/')).toBe(false);
		client.stop();
	});

	it('forgets a stored token the server rejects and on sign-out', async () => {
		storage.set('bottomless.session:ws://fake.test/', 'stale');
		const client = new ChatClient('ws://fake.test/');
		client.subscribe((next) => (snapshot = next));
		client.start();
		latest().open();
		latest().receive({ method: 'server', params: { protocol: 1, auth: ['webauthn', 'token', 'anonymous'], caps: [] } });
		const auth = latest().sent.find((frame) => frame.method === 'auth')!;
		expect(auth.params).toEqual(expect.objectContaining({ scheme: 'token', token: 'stale' }));
		latest().receive({ id: auth.id, error: { code: -32001, message: 'Session expired; sign in with your passkey' } });
		await Promise.resolve();
		await Promise.resolve();
		expect(storage.has('bottomless.session:ws://fake.test/')).toBe(false);
		expect(snapshot.error).toBe('Session expired; sign in with your passkey');
		expect(snapshot.authenticated).toBe(false);

		storage.set('bottomless.session:ws://fake.test/', 'fresh');
		const again = new ChatClient('ws://fake.test/');
		again.start();
		await latest().greet([], { auth: ['webauthn', 'token', 'anonymous'], token: 'fresh' });
		await again.signOut();
		expect(storage.has('bottomless.session:ws://fake.test/')).toBe(false);
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
