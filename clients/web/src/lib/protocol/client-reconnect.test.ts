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
	async greet(caps: string[] = []): Promise<void> {
		this.open();
		this.receive({ method: 'server', params: { protocol: 1, name: 'fake', auth: ['anonymous'], caps } });
		const auth = this.sent.find((frame) => frame.method === 'auth');
		if (!auth) throw new Error('client did not authenticate');
		this.receive({ id: auth.id, result: { you: { user_id: 'guest-1', name: 'Guest' } } });
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
});
