import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { canonicalizeIp, hashIpKey } from '../src/ip';

type Frame = { id?: string | null; method?: string; result?: any; error?: any; params?: any };
let nextIp = 1;

// These are server-owned fields that must never cross the protocol boundary.
// Do not reject arbitrary keys in message bodies or extensions: those are
// intentionally client-controlled public data and may use any JSON shape.
const PRIVATE_SERVER_KEYS = new Set([
	'ipKey', 'ip_key', 'credentialId', 'credential_id', 'publicKey',
	'userHandle', 'user_handle', 'challengeId', 'identityUserId',
	'identity_user_id', 'expiresAt', 'expires_at', 'accountUsage', 'account_usage',
	'resourceBudgets', 'resource_budgets', 'budgetStop', 'budget_stop',
	'signCount', 'sign_count', 'publicKeyJson', 'public_key_json',
]);

function serverOwnedValues(frame: Frame): Array<{ key: string; value: unknown }> {
	const values: Array<{ key: string; value: unknown }> = [];
	const visit = (value: unknown, path: string[], userControlled = false): void => {
		if (userControlled || !value || typeof value !== 'object') return;
		if (Array.isArray(value)) {
			for (const child of value) visit(child, path, false);
			return;
		}
		for (const [key, child] of Object.entries(value)) {
			if (PRIVATE_SERVER_KEYS.has(key)) values.push({ key, value: child });
			const childIsUserControlled = (path.at(-1) === 'message' && (key === 'body' || key === 'extension')) ||
				(path.length === 1 && path[0] === 'params' && key === 'thread');
			visit(child, [...path, key], childIsUserControlled);
		}
	};
	visit(frame, [], false);
	return values;
}

function expectPublicFrame(frame: Frame): void {
	expect(serverOwnedValues(frame), `private server data in ${JSON.stringify(frame)}`).toEqual([]);
}

async function connect(ip = `192.0.2.${nextIp++}`, path = '/ws', origin: string | null = 'http://localhost:5173') {
	const response = await SELF.fetch(`https://demo.test${path}`, { headers: {
		Upgrade: 'websocket', ...(origin === null ? {} : { Origin: origin }), 'CF-Connecting-IP': ip
	} });
	expect(response.status).toBe(101);
	const socket = response.webSocket!;
	const frames: Frame[] = [];
	const waiters: ((frame: Frame) => void)[] = [];
	socket.addEventListener('message', event => {
		const frame = JSON.parse(String(event.data));
		const waiter = waiters.shift();
		if (waiter) waiter(frame); else frames.push(frame);
	});
	socket.accept();
	return {
		socket,
		send(frame: unknown) { socket.send(JSON.stringify(frame)); },
		next(): Promise<Frame> {
			const frame = frames.shift();
			return frame ? Promise.resolve(frame) : new Promise(resolve => waiters.push(resolve));
		},
		close() { socket.close(1000, 'test complete'); }
	};
}

async function authenticate(peer: Awaited<ReturnType<typeof connect>>) {
	const server = await peer.next();
	expect(server.method).toBe('server');
	expect(server.params.auth).toContain('webauthn');
	expect(server.params.extensions).toBeUndefined();
	peer.send({ method: 'auth', id: 'auth', params: { scheme: 'anonymous' } });
	const auth = await peer.next();
	expect(auth.result.you.user_id).toBeTruthy();
	const room = await peer.next();
	expect(room.method).toBe('room');
	expect(room.params.room_id).toBe('general');
	expect(room.params.latest_log_id).toMatch(/^(0|[1-9][0-9]*)$/);
	if (room.params.latest_log_id === '0') expect(room.params.history_log_id).toBeNull();
	else expect(room.params.history_log_id).toMatch(/^[1-9][0-9]*$/);
	return auth.result.you;
}

it('admits clients without Origin as guests without advertising or allowing passkeys', async () => {
	const peer = await connect(undefined, '/', null);
	try {
		expect((await peer.next()).params.auth).toEqual(['anonymous']);
		peer.send({ id: 'auth', method: 'auth', params: { scheme: 'anonymous' } });
		expect((await peer.next()).result.you.user_id).toBeTruthy();
		await peer.next(); // Room announcement.
		peer.send({ id: 'passkey', method: 'auth', params: { scheme: 'webauthn', action: 'register', step: 'begin' } });
		expect((await peer.next()).error.code).toBe(-32001);
	} finally { peer.close(); }
});

it('keeps server-owned state out of public protocol frames', async () => {
	const ip = `198.51.100.${nextIp++}`;
	const ipHash = await hashIpKey(canonicalizeIp(ip)!);
	const peer = await connect(ip);
	const publicFrames: Frame[] = [];
	try {
		const server = await peer.next();
		publicFrames.push(server);
		expectPublicFrame(server);
		expect(server.params.auth).toEqual(['webauthn', 'anonymous']);

		peer.send({ id: 'auth', method: 'auth', params: { scheme: 'anonymous' } });
		const auth = await peer.next();
		publicFrames.push(auth);
		expectPublicFrame(auth);
		const room = await peer.next();
		publicFrames.push(room);
		expectPublicFrame(room);

		peer.send({ id: 'post', method: 'message', params: {
			room_id: 'general', body: { text: 'disclosure regression', extension: { ipKey: 'client-controlled' } },
		} });
		const saved = await peer.next();
		publicFrames.push(saved);
		expectPublicFrame(saved);
		const broadcast = await peer.next();
		publicFrames.push(broadcast);
		expectPublicFrame(broadcast);

		peer.send({ id: 'history', method: 'history', params: { room_id: 'general', limit: 10 } });
		const history = await peer.next();
		publicFrames.push(history);
		expectPublicFrame(history);

		peer.send({ id: 'bad', method: 'message', params: { room_id: 'private-room', body: { text: 'nope' } } });
		const error = await peer.next();
		publicFrames.push(error);
		expectPublicFrame(error);
		expect(error.error.code).toBe(-32602);

		peer.send({ id: 'passkey', method: 'auth', params: { scheme: 'webauthn', action: 'register', step: 'begin' } });
		const challenge = await peer.next();
		publicFrames.push(challenge);
		expectPublicFrame(challenge);
		expect(Object.keys(challenge.result).sort()).toEqual(['challenge_id', 'public_key']);
		expect(challenge.result.challenge_id).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(challenge.result.public_key.challenge).toBeTruthy();
		expect(challenge.result.public_key.user.id).toBeTruthy();
		// The challenge ID and generated public-key options are the documented
		// WebAuthn ceremony surface; the internal attachment is never returned.
		expect(JSON.stringify(publicFrames)).not.toContain(ipHash);
	} finally { peer.close(); }
});

it('authenticates on the root WebSocket endpoint and still serves the homepage', async () => {
	const response = await SELF.fetch('https://demo.test/');
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toContain('text/html');
	const peer = await connect(undefined, '/');
	try { await authenticate(peer); } finally { peer.close(); }
	const denied = await SELF.fetch('https://demo.test/', { headers: {
		Upgrade: 'websocket', Origin: 'https://untrusted.example', 'CF-Connecting-IP': '192.0.2.240'
	} });
	expect(denied.status).toBe(403);
});

it('commits once for canonical retries, preserves extensions, and sends no reply to notifications', async () => {
	const peer = await connect();
	try {
		const you = await authenticate(peer);
		peer.send({ jsonrpc: '2.0', id: '', method: 'message', params: {
			room_id: 'general', body: { text: 'hello', format: 'plain' }, extension: { z: 1, a: 2 }, from: { user_id: 'spoof' }
		} });
		const saved = await peer.next();
		expect(saved.id).toBe('');
		expect(saved.result.message_id).toMatch(/^[1-9][0-9]*$/);
		const broadcast = await peer.next();
		expect(broadcast.method).toBe('message');
		expect(broadcast.params.echo).toBe('');
		expect(broadcast.params.message.from.user_id).toBe(you.user_id);
		expect(broadcast.params.message.extension).toEqual({ a: 2, z: 1 });
		peer.send({ id: '', method: 'message', params: {
			from: { user_id: 'spoof' }, extension: { a: 2, z: 1 }, body: { format: 'plain', text: 'hello' }, room_id: 'general'
		} });
		expect((await peer.next()).result).toEqual(saved.result);
		peer.send({ method: 'unimplemented-notification', params: {} });
		peer.send({ method: 'history', id: 'history', params: {
			room_id: 'general', after: broadcast.params.log_id, before: broadcast.params.log_id
		} });
		const page = await peer.next();
		expect(page.id).toBe('history');
		expect(page.result.entries).toHaveLength(1);
		expect(page.result.entries[0].message.extension).toEqual({ a: 2, z: 1 });
		peer.send({ id: '', method: 'message', params: { room_id: 'general', body: { text: 'changed request' } } });
		expect((await peer.next()).error.code).toBe(-32602);
	} finally { peer.close(); }
});

it('counts anonymous posting across sockets and returns retained retries after posting exhaustion', async () => {
	const ip = `198.51.100.${nextIp++}`;
	const first = await connect(ip);
	const second = await connect(ip);
	try {
		await authenticate(first);
		await authenticate(second);
		let accepted: any;
		for (let i = 0; i < 5; i++) {
			const writer = i % 2 ? second : first;
			const other = i % 2 ? first : second;
			writer.send({ id: `post-${i}`, method: 'message', params: { room_id: 'general', body: { text: `post-${i}` } } });
			const result = await writer.next();
			expect(result.result.message_id).toBeTruthy();
			if (i === 0) accepted = result.result;
			expect((await writer.next()).method).toBe('message');
			expect((await other.next()).method).toBe('message');
		}
		second.send({ id: 'sixth', method: 'message', params: { room_id: 'general', body: { text: 'limited' } } });
		const limited = await second.next();
		expect(limited.error.code).toBe(-32002);
		expect(limited.error.data.ms).toBeGreaterThan(0);
		first.send({ id: 'post-0', method: 'message', params: { room_id: 'general', body: { text: 'post-0' } } });
		expect((await first.next()).result).toEqual(accepted);
	} finally { first.close(); second.close(); }
});

it('pipelined anonymous auth precedes mutation and errors preserve identifiable IDs', async () => {
	const peer = await connect();
	try {
		expect((await peer.next()).method).toBe('server');
		peer.send({ id: 'a', method: 'auth', params: { scheme: 'anonymous' } });
		peer.send({ id: 'm', method: 'message', params: { room_id: 'general', body: { text: 'pipelined' } } });
		expect((await peer.next()).id).toBe('a');
		expect((await peer.next()).method).toBe('room');
		expect((await peer.next()).id).toBe('m');
		expect((await peer.next()).method).toBe('message');
		peer.socket.send('{');
		const parse = await peer.next();
		expect(parse.id).toBeNull();
		expect(parse.error.code).toBe(-32700);
		peer.send({ id: 'unknown', method: 'not-implemented' });
		const unsupported = await peer.next();
		expect(unsupported.id).toBe('unknown');
		expect(unsupported.error.code).toBe(-32601);
	} finally { peer.close(); }
});
