/**
 * Test support: a minimal scripted WebSocket for driving `ChatClient` in unit
 * tests. Frames the client sends are parsed into `sent`; tests reply through
 * `receive` and drop the transport with `drop`. Not used by the app.
 */
export class FakeSocket {
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

	static latest(): FakeSocket {
		const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
		if (!socket) throw new Error('no socket has been opened');
		return socket;
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

	/** The most recent outgoing request with this method. */
	request(method: string): Record<string, unknown> & { id: string; params: Record<string, unknown> } {
		const frame = [...this.sent].reverse().find((entry) => entry.method === method && typeof entry.id === 'string');
		if (!frame) throw new Error(`client sent no ${method} request`);
		return frame as Record<string, unknown> & { id: string; params: Record<string, unknown> };
	}

	/** Reply to the most recent request with this method and let promise callbacks run. */
	async reply(method: string, result: Record<string, unknown>): Promise<void> {
		this.receive({ id: this.request(method).id, result });
		await settle();
	}

	/** Runs the greeting, answers the auth request, and announces one room. */
	async greet(caps: string[] = [], options: { auth?: string[]; token?: string; room?: Record<string, unknown> } = {}): Promise<void> {
		this.open();
		this.receive({ method: 'server', params: { protocol: 3, name: 'fake', auth: options.auth ?? ['guest'], caps } });
		const auth = this.sent.find((frame) => frame.method === 'auth');
		if (!auth) throw new Error('client did not authenticate');
		this.receive({ id: auth.id, result: { you: { user_id: 'guest_1', name: 'Guest' }, ...(options.token ? { token: options.token } : {}) } });
		// The auth response settles through a promise before the client applies it.
		await settle();
		this.receive({ method: 'room', params: options.room ?? { room_id: 'lobby', title: 'Lobby' } });
	}
}

export async function settle(): Promise<void> {
	for (let turn = 0; turn < 4; turn++) await Promise.resolve();
}
