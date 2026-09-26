import { env, runInDurableObject, SELF } from 'cloudflare:test';
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
			// Message bodies and ext objects are client-controlled public data.
			const childIsUserControlled = key === 'body' || key === 'ext';
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

/** Drain frames until one matches; earlier frames are returned for inspection. */
async function until(peer: Awaited<ReturnType<typeof connect>>, match: (frame: Frame) => boolean): Promise<{ frame: Frame; skipped: Frame[] }> {
	const skipped: Frame[] = [];
	for (;;) {
		const frame = await peer.next();
		if (match(frame)) return { frame, skipped };
		skipped.push(frame);
	}
}

type Peer = Awaited<ReturnType<typeof connect>>;

async function authenticate(peer: Peer, scheme = 'guest', extraCaps: string[] = []) {
	const server = await peer.next();
	expect(server.method).toBe('server');
	expect(server.params.protocol).toBe(6);
	expect(server.params.caps).toEqual(['history', 'edit', 'rooms', 'reactions', 'command', ...extraCaps]);
	expect(server.params.auth).toContain('webauthn');
	expect(server.params.ping).toBe(45);
	expect(server.params.extensions).toBeUndefined();
	// Demo hints live under the standard ext object, not a top-level key.
	expect(server.params.ext.demo.retention_seconds).toBeGreaterThan(0);
	peer.send({ method: 'auth', id: 'auth', params: { scheme } });
	const auth = await peer.next();
	expect(auth.result.you.user_id).toMatch(/^guest_/);
	// Rooms are not announced (§4.3.1): the client lists them.
	return auth.result.you;
}

type ServerInternals = { config: { limits: Record<string, number>; activityEnabled: boolean }; recentFrames: number[] };

/** Changes the running demo object's policy for one test; the next test restores it. */
async function configure(update: (config: ServerInternals['config']) => void): Promise<void> {
	await runInDurableObject(env.DEMO.getByName('public-demo-v1'), (instance) => {
		const server = instance as unknown as ServerInternals;
		server.config = { ...server.config, limits: { ...server.config.limits } };
		update(server.config);
		server.recentFrames.length = 0;
	});
}

/** Skip notifications that precede the next request's reply. */
async function reply(peer: Peer, id: string): Promise<Frame> {
	return (await until(peer, frame => frame.id === id)).frame;
}

/** Sends a request; its reply and the notifications that preceded it. */
async function exchange(peer: Peer, id: string, method: string, params: unknown): Promise<{ frame: Frame; skipped: Frame[] }> {
	peer.send({ id, method, params });
	return until(peer, (frame) => frame.id === id);
}

/** Sends a request and returns its reply, skipping notifications before it. */
async function request(peer: Peer, id: string, method: string, params: unknown): Promise<Frame> {
	return (await exchange(peer, id, method, params)).frame;
}

let syncCounter = 0;
/**
 * The notifications a peer received before a round trip made now: a `me`
 * without fields, which changes nothing. Frames are delivered in order, so
 * anything sent to the peer before this call is among them.
 */
async function drain(peer: Peer): Promise<Frame[]> {
	const id = `sync-${++syncCounter}`;
	peer.send({ id, method: 'me', params: {} });
	return (await until(peer, (frame) => frame.id === id)).skipped;
}

const ids = (rooms: Array<{ room_id: string }> | undefined) => (rooms ?? []).map((room) => room.room_id);

it('admits clients without Origin as guests without advertising or allowing passkeys', async () => {
	const peer = await connect(undefined, '/', null);
	try {
		expect((await peer.next()).params.auth).toEqual(['guest']);
		peer.send({ id: 'auth', method: 'auth', params: { scheme: 'guest' } });
		expect((await peer.next()).result.you.user_id).toMatch(/^guest_/);
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
		expect(server.params.auth).toEqual(['webauthn', 'token', 'guest']);

		peer.send({ id: 'auth', method: 'auth', params: { scheme: 'guest' } });
		const auth = await peer.next();
		publicFrames.push(auth);
		expectPublicFrame(auth);
		const rooms = await request(peer, 'rooms', 'room_list', { filter: 'joined', members: true });
		publicFrames.push(rooms);
		expectPublicFrame(rooms);

		const posted = await exchange(peer, 'post', 'message', {
			room_id: 'general', body: { text: 'disclosure regression' }, ext: { demo: { ipKey: 'client-controlled' } },
		});
		const saved = posted.frame;
		publicFrames.push(saved);
		expectPublicFrame(saved);
		const broadcast = posted.skipped[0];
		publicFrames.push(broadcast);
		expectPublicFrame(broadcast);

		peer.send({ id: 'react', method: 'reactions', params: { message_id: saved.result.message_id, emojis: ['👍'] } });
		publicFrames.push(await peer.next(), await peer.next());
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

it('answers the liveness ping before and after authentication', async () => {
	const peer = await connect();
	try {
		const server = await peer.next();
		expect(server.params.ping).toBe(45);
		// The exact bytes are answered by the runtime, before auth too (§1).
		peer.socket.send('{"method":"ping"}');
		expect(await peer.next()).toEqual({ method: 'pong' });
		// Other spacing reaches the handler, which answers it as well.
		peer.socket.send('{ "method": "ping" }');
		expect(await peer.next()).toEqual({ method: 'pong' });
		// A ping request is not the liveness ping: before auth it is denied.
		peer.send({ id: 'ping-request', method: 'ping' });
		expect((await peer.next()).error.code).toBe(-32001);
		peer.send({ id: 'auth', method: 'auth', params: { scheme: 'guest' } });
		expect((await peer.next()).result.you.user_id).toMatch(/^guest_/);
		peer.socket.send('{"method":"ping"}');
		expect(await peer.next()).toEqual({ method: 'pong' });
	} finally { peer.close(); }
});

it('commits once for canonical retries, passes ext through, and sends no reply to notifications', async () => {
	const peer = await connect();
	try {
		const you = await authenticate(peer);
		peer.send({ jsonrpc: '2.0', id: '', method: 'message', params: {
			room_id: 'general', body: { text: 'hello' }, ext: { z: 1, a: 2 }, from: { user_id: 'spoof' }, stray: true,
		} });
		// The broadcast comes before the result on the sender's connection (§1).
		const broadcast = await peer.next();
		const saved = await peer.next();
		expect(saved.id).toBe('');
		expect(saved.result.message_id).toMatch(/^[1-9][0-9]*$/);
		// A flat, self-describing snapshot.
		expect(broadcast).toEqual({ method: 'message', params: {
			message_id: saved.result.message_id, log_id: saved.result.message_id, room_id: 'general',
			from: you, body: { text: 'hello', format: 'plain', embeds: [] }, ext: { z: 1, a: 2 },
		} });
		peer.send({ id: '', method: 'message', params: {
			stray: true, from: { user_id: 'spoof' }, ext: { a: 2, z: 1 }, body: { text: 'hello' }, room_id: 'general'
		} });
		expect((await peer.next()).result).toEqual(saved.result);
		peer.send({ method: 'unimplemented-notification', params: {} });
		peer.send({ method: 'history', id: 'history', params: {
			room_id: 'general', after: broadcast.params.log_id, before: broadcast.params.log_id
		} });
		const page = await peer.next();
		expect(page.id).toBe('history');
		expect(page.result.messages).toEqual([broadcast.params]);
		peer.send({ id: '', method: 'message', params: { room_id: 'general', body: { text: 'changed request' } } });
		expect((await peer.next()).error.code).toBe(-32602);
	} finally { peer.close(); }
});

it('counts guest posting across sockets and returns retained retries after posting exhaustion', async () => {
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
			expect((await writer.next()).method).toBe('message');
			const result = await writer.next();
			expect(result.result.message_id).toBeTruthy();
			if (i === 0) accepted = result.result;
			expect((await other.next()).method).toBe('message');
		}
		second.send({ id: 'sixth', method: 'message', params: { room_id: 'general', body: { text: 'limited' } } });
		const limited = await second.next();
		expect(limited.error.code).toBe(-32002);
		expect(Number.isInteger(limited.error.data.retry_after)).toBe(true);
		expect(limited.error.data.retry_after).toBeGreaterThanOrEqual(1);
		first.send({ id: 'post-0', method: 'message', params: { room_id: 'general', body: { text: 'post-0' } } });
		expect((await first.next()).result).toEqual(accepted);
	} finally { first.close(); second.close(); }
});

it('pipelined guest auth precedes mutation and errors preserve identifiable IDs', async () => {
	const peer = await connect();
	try {
		expect((await peer.next()).method).toBe('server');
		peer.send({ id: 'a', method: 'auth', params: { scheme: 'guest' } });
		peer.send({ id: 'm', method: 'message', params: { room_id: 'general', body: { text: 'pipelined' } } });
		expect((await peer.next()).id).toBe('a');
		expect((await peer.next()).method).toBe('message');
		expect((await peer.next()).id).toBe('m');
		peer.socket.send('{');
		const parse = await peer.next();
		// An error not tied to a request omits id.
		expect('id' in parse).toBe(false);
		expect(parse.error.code).toBe(-32700);
		peer.send({ id: 'unknown', method: 'not-implemented' });
		const unsupported = await peer.next();
		expect(unsupported.id).toBe('unknown');
		expect(unsupported.error.code).toBe(-32601);
	} finally { peer.close(); }
});

it('posts and pages the default room without room_id, and neither logs nor delivers an empty message', async () => {
	const alice = await connect();
	const bob = await connect();
	try {
		const aliceId = await authenticate(alice);
		await authenticate(bob);
		const posted = await request(alice, 'default', 'message', { body: { text: 'to the default room' } });
		const snapshot = (await until(bob, (frame) => frame.method === 'message')).frame.params;
		expect(snapshot).toMatchObject({ message_id: posted.result.message_id, room_id: 'general', from: aliceId });
		const page = await request(bob, 'default-history', 'history', { after: snapshot.log_id });
		expect(page.result.messages).toEqual([snapshot]);
		// An empty new message: result `{}`, nothing logged or broadcast (§3.5).
		for (const [id, params] of [['empty', { body: { text: '' } }], ['blank', { room_id: 'general', body: { embeds: [] } }]] as const) {
			expect((await request(alice, id, 'message', params)).result).toEqual({});
		}
		expect((await request(alice, 'empty-missing-room', 'message', { room_id: 'missing', body: {} })).error.code).toBe(-32602);
		expect((await drain(alice)).filter((frame) => frame.method === 'message')).toEqual([]);
		expect((await drain(bob)).filter((frame) => frame.method === 'message')).toEqual([]);
		const after = await request(bob, 'after-empty', 'history', { after: snapshot.log_id });
		expect(after.result.messages).toEqual([snapshot]);
	} finally { alice.close(); bob.close(); }
});

it('stores body.mentions as sent and never reads mentions out of text', async () => {
	const peer = await connect();
	try {
		const you = await authenticate(peer);
		const plain = (await exchange(peer, 'plain', 'message', { body: { text: `@${you.user_id} hello @someone` } })).skipped.find((frame) => frame.method === 'message')!.params;
		expect(plain.body.mentions).toBeUndefined();
		const listed = (await exchange(peer, 'listed', 'message', { body: { text: 'no at signs here', mentions: [you.user_id, 'bob', you.user_id] } })).skipped.find((frame) => frame.method === 'message')!.params;
		// Duplicates collapse; users need not appear in text.
		expect(listed.body.mentions).toEqual([you.user_id, 'bob']);
		expect((await request(peer, 'bad-mentions', 'message', { body: { text: 'x', mentions: 'bob' } })).error.code).toBe(-32602);
	} finally { peer.close(); }
});

it('rejects operations guests may not perform and the v4 room method', async () => {
	// Three invalid requests within a minute close a socket, so spread them.
	const peer = await connect();
	const other = await connect();
	try {
		await authenticate(peer);
		await authenticate(other);
		expect((await request(peer, 'top-level', 'room_set', { title: 'Top level' })).error.code).toBe(-32001);
		// Guests keep their assigned name.
		expect((await request(peer, 'rename', 'me', { name: 'Ada' })).error.code).toBe(-32001);
		// Rooms are no longer announced or saved with `room`.
		expect((await request(peer, 'v4-room', 'room', { parent_room_id: 'general', title: 'Old' })).error.code).toBe(-32601);
		expect((await request(other, 'unknown-history', 'history', { room_id: 'missing' })).error.code).toBe(-32602);
		expect((await request(other, 'join-missing', 'room_join', { room_id: 'missing' })).error.code).toBe(-32602);
		expect((await request(peer, 'leave-missing', 'room_leave', { room_id: 'missing' })).error.code).toBe(-32602);
	} finally { peer.close(); other.close(); }
});

it('creates threads with room_set, delivers only to joined rooms, and moves messages with their reactions', async () => {
	const alice = await connect();
	const bob = await connect();
	try {
		const aliceId = await authenticate(alice);
		const bobId = await authenticate(bob);
		const both = async (method: string) => {
			const frames = [(await until(alice, frame => frame.method === method)).frame, (await until(bob, frame => frame.method === method)).frame];
			expect(frames[1]).toEqual(frames[0]);
			return frames[0].params;
		};

		// Broadcasts come before the result that caused them (§1).
		alice.send({ id: 'post', method: 'message', params: { room_id: 'general', body: { text: 'belongs in a thread' } } });
		const original = await both('message');
		const messageId = (await reply(alice, 'post')).result.message_id;

		bob.send({ id: 'react', method: 'reactions', params: { message_id: messageId, emojis: ['👍', '👍'] } });
		const reaction = await both('reactions');
		expect((await reply(bob, 'react')).result).toEqual({});
		expect(reaction).toEqual({
			log_id: reaction.log_id, message_id: messageId, room_id: 'general',
			reactions: [{ from: bobId, emojis: ['👍'] }],
		});
		bob.send({ id: 'react-missing', method: 'reactions', params: { message_id: '404', emojis: ['👍'] } });
		expect((await reply(bob, 'react-missing')).error.code).toBe(-32602);

		// Creating a thread joins its creator: `joined` before the result, and
		// `updated` to the parent's other members, who are not joined.
		alice.send({ id: 'thread', method: 'room_set', params: { parent_room_id: 'general', title: 'Deploy', intro_message: { message_id: messageId } } });
		const created = await until(alice, (frame) => frame.id === 'thread');
		const roomId = created.frame.result.room_id;
		const room = {
			room_id: roomId, log_id: roomId, parent_room_id: 'general', title: 'Deploy',
			intro_message: original, latest_log_id: roomId, history_log_id: roomId,
		};
		// `joined` carries the members, bare, and their current objects in
		// `users`; a guest's join is not logged, so no membership follows.
		expect(created.skipped).toEqual([{ method: 'room_update', params: { joined: [{ ...room, members: [{ user_id: aliceId.user_id }] }], users: [aliceId] } }]);
		expect((await until(bob, (frame) => frame.method === 'room_update')).frame).toEqual({ method: 'room_update', params: { updated: [room] } });

		// Posting does not require joining, and a poster who has not joined
		// gets only the result.
		const outside = await request(bob, 'outside', 'message', { room_id: roomId, body: { text: 'posted from outside' } });
		expect(outside.result.message_id).toBeTruthy();
		const inside = (await until(alice, (frame) => frame.method === 'message')).frame.params;
		expect(inside).toMatchObject({ message_id: outside.result.message_id, room_id: roomId, from: bobId });
		expect((await drain(bob)).filter((frame) => frame.method === 'message')).toEqual([]);

		alice.send({ id: 'move', method: 'message', params: { message_id: messageId, room_id: roomId, body: { text: 'moved' }, reply_to: { message_id: messageId } } });
		expect((await reply(alice, 'move')).error.code).toBe(-32602);
		alice.send({ id: 'move-2', method: 'message', params: { message_id: messageId, room_id: roomId, body: { text: 'moved' } } });
		// The move snapshot belongs to both rooms, so general's members get it;
		// the reactions re-logged in the thread reach only its members.
		const moved = await both('message');
		expect(moved).toMatchObject({ message_id: messageId, room_id: roomId, from: aliceId, body: { text: 'moved' } });
		const followed = (await until(alice, (frame) => frame.method === 'reactions')).frame.params;
		expect((await reply(alice, 'move-2')).result).toEqual({ message_id: messageId });
		expect(followed).toMatchObject({ message_id: messageId, room_id: roomId, reactions: [{ from: bobId, emojis: ['👍'] }] });
		expect(BigInt(followed.log_id)).toBeGreaterThan(BigInt(moved.log_id));
		expect((await drain(bob)).filter((frame) => frame.method === 'reactions')).toEqual([]);

		// Every room is visible: history needs no membership.
		const general = (await request(bob, 'general-history', 'history', { room_id: 'general', after: original.log_id })).result;
		expect(general.messages.map((entry: any) => [entry.log_id, entry.room_id])).toEqual([[original.log_id, 'general'], [moved.log_id, roomId]]);
		expect(general.reactions).toEqual([reaction]);
		const thread = (await request(bob, 'thread-history', 'history', { room_id: roomId })).result;
		// History room records carry the room's current delivery fields.
		expect(thread.rooms).toEqual([{ ...room, latest_log_id: followed.log_id }]);
		expect(thread.messages).toEqual([inside, moved]);
		expect(thread.reactions).toEqual([followed]);
		expect(thread.membership).toBeUndefined();
		expect([thread.first_log_id, thread.last_log_id, thread.more]).toEqual([roomId, followed.log_id, false]);
		expect([thread.latest_log_id, thread.history_log_id]).toEqual([followed.log_id, roomId]);
		// The move snapshot names the room holding its earlier snapshot (§2),
		// and a window bounded to one log_id reads that room's log only.
		expect(moved.prev_log_id).toBe(original.log_id);
		expect(moved.prev_room_id).toBe('general');
		const elsewhere = (await request(bob, 'elsewhere', 'history', { room_id: roomId, after: moved.prev_log_id, before: moved.prev_log_id })).result;
		expect(elsewhere).toEqual({ more: false, latest_log_id: followed.log_id, history_log_id: roomId });
		const earlier = (await request(bob, 'earlier', 'history', { room_id: moved.prev_room_id, after: moved.prev_log_id, before: moved.prev_log_id })).result;
		expect(earlier.messages).toEqual([original]);
		expect([earlier.first_log_id, earlier.last_log_id, earlier.more]).toEqual([original.log_id, original.log_id, false]);

		// Joining: `joined`, with the members after the join, before `{}`.
		const members = [aliceId, bobId].sort((a, b) => a.user_id < b.user_id ? -1 : 1);
		const joinedRoom = { ...room, intro_message: moved, latest_log_id: followed.log_id, members: members.map((member) => ({ user_id: member.user_id })) };
		const joined = await exchange(bob, 'join', 'room_join', { room_id: roomId });
		expect(joined.frame.result).toEqual({});
		expect(joined.skipped).toEqual([{ method: 'room_update', params: { joined: [joinedRoom], users: members } }]);
		// A second join logs nothing and re-sends `joined` to that connection only.
		const again = await exchange(bob, 'join-again', 'room_join', { room_id: roomId });
		expect(again.skipped).toEqual([{ method: 'room_update', params: { joined: [joinedRoom], users: members } }]);

		// Any participant may save a thread; `updated` reaches the room's and
		// the parent's members, and the result follows it.
		bob.send({ id: 'rename', method: 'room_set', params: { room_id: roomId, title: 'Deploys', parent_room_id: 'ignored' } });
		const renamedReply = await until(bob, (frame) => frame.id === 'rename');
		expect(renamedReply.frame.result).toEqual({ room_id: roomId });
		const renamed = renamedReply.skipped.find((frame) => frame.method === 'room_update')!.params.updated[0];
		expect(renamed).toMatchObject({ room_id: roomId, parent_room_id: 'general', title: 'Deploys' });
		expect(renamed.intro_message).toBeUndefined();
		expect((await until(alice, (frame) => frame.method === 'room_update')).frame.params).toEqual({ updated: [renamed] });

		// Now a member, Bob receives the thread's messages.
		await request(alice, 'in-thread', 'message', { room_id: roomId, body: { text: 'for members' } });
		expect((await until(bob, (frame) => frame.method === 'message')).frame.params.body.text).toBe('for members');

		// Leaving: `left` before `{}`, and deliveries stop.
		const left = await exchange(bob, 'leave', 'room_leave', { room_id: roomId });
		expect(left.frame.result).toEqual({});
		expect(left.skipped).toEqual([{ method: 'room_update', params: { left: [{ room_id: roomId }] } }]);
		expect((await request(bob, 'leave-again', 'room_leave', { room_id: roomId })).result).toEqual({});
		await request(alice, 'after-leave', 'message', { room_id: roomId, body: { text: 'members only' } });
		expect((await drain(bob)).filter((frame) => frame.method === 'message')).toEqual([]);

		// Leaving general stops its deliveries too; posting there still works.
		expect((await request(bob, 'leave-general', 'room_leave', { room_id: 'general' })).result).toEqual({});
		await request(alice, 'general-after', 'message', { body: { text: 'bob is not here' } });
		expect((await drain(bob)).filter((frame) => frame.method === 'message')).toEqual([]);
		expect((await request(bob, 'post-anyway', 'message', { body: { text: 'posting without joining' } })).result.message_id).toBeTruthy();
		expect((await drain(bob)).filter((frame) => frame.method === 'message')).toEqual([]);
		const unjoined = (await request(bob, 'browse', 'room_list', { filter: 'not_joined' })).result;
		expect(ids(unjoined.not_joined)).toEqual(['general']);
		expect(unjoined.joined).toBeUndefined();
		expect((await request(bob, 'rejoin', 'room_join', { room_id: 'general' })).result).toEqual({});
	} finally { alice.close(); bob.close(); }

	// A later session has joined only general and finds the thread by listing.
	const late = await connect();
	try {
		await authenticate(late);
		const mine = (await request(late, 'mine', 'room_list', { filter: 'joined' })).result;
		expect(ids(mine.joined)).toEqual(['general']);
		expect(mine.not_joined).toBeUndefined();
		const threads = (await request(late, 'threads', 'room_list', { parent_room_id: 'general', filter: 'not_joined' })).result;
		expect(threads.not_joined.every((room: { parent_room_id?: string }) => room.parent_room_id === 'general')).toBe(true);
		expect(threads.not_joined.length).toBeGreaterThan(0);
	} finally { late.close(); }
});

it('leaves activity off by default: not advertised, and typing is not relayed', async () => {
	const alice = await connect();
	const bob = await connect();
	try {
		await authenticate(alice);
		await authenticate(bob);
		alice.send({ method: 'activity', params: { room_id: 'general', typing: 5 } });
		alice.send({ id: 'typing-request', method: 'activity', params: { room_id: 'general', typing: 5 } });
		expect((await until(alice, (frame) => frame.id === 'typing-request')).frame.error.code).toBe(-32601);
		alice.send({ id: 'after', method: 'message', params: { room_id: 'general', body: { text: 'no typing relayed' } } });
		const done = await until(bob, (frame) => frame.method === 'message' && frame.params.body?.text === 'no typing relayed');
		expect(done.skipped.filter((frame) => frame.method === 'activity')).toEqual([]);
	} finally { alice.close(); bob.close(); }
});

it('limits the frames the whole server processes in a minute without closing sockets', async () => {
	await configure((config) => { config.limits.globalFramesPerMinute = 4; });
	const peer = await connect();
	try {
		await authenticate(peer);
		for (let index = 0; index < 3; index += 1) {
			expect((await request(peer, `sync-${index}`, 'me', {})).result.you).toBeTruthy();
		}
		const busy = (await request(peer, 'busy', 'me', {})).error;
		expect(busy.code).toBe(-32002);
		expect(busy.data.retry_after).toBeGreaterThan(0);
		// The socket stays open and a later minute is served again.
		await configure((config) => { config.limits.globalFramesPerMinute = 300; });
		expect((await request(peer, 'again', 'me', {})).result.you).toBeTruthy();
	} finally { peer.close(); await configure((config) => { config.limits.globalFramesPerMinute = 300; }); }
});

it('with ACTIVITY on, relays typing to room members, accepts away, throttles per user, and tells only the sender once', async () => {
	await configure((config) => { config.activityEnabled = true; });
	const alice = await connect();
	const bob = await connect();
	const carol = await connect();
	try {
		const aliceId = await authenticate(alice, 'guest', ['activity']);
		await authenticate(bob, 'guest', ['activity']);
		await authenticate(carol, 'guest', ['activity']);
		// Carol has left general, so typing there is not relayed to her.
		await request(carol, 'leave', 'room_leave', { room_id: 'general' });
		// `away` is accepted and never delivered, with or without a room.
		alice.send({ method: 'activity', params: { away: true } });
		alice.send({ method: 'activity', params: { typing: 99 } });
		const first = await until(bob, (frame) => frame.method === 'activity');
		// Typing is capped by policy, in the default room without room_id; the
		// sender's own connection is not echoed.
		expect(first.frame.params).toEqual({ room_id: 'general', from: aliceId, typing: 30 });
		// A read cursor is neither kept nor relayed, and does not count.
		alice.send({ method: 'activity', params: { room_id: 'general', read_message_id: '1' } });
		// Unknown rooms are dropped too.
		alice.send({ method: 'activity', params: { room_id: '999', typing: 5 } });
		for (let index = 0; index < 11; index += 1) alice.send({ method: 'activity', params: { room_id: 'general', typing: index } });
		alice.send({ id: 'after', method: 'message', params: { room_id: 'general', body: { text: 'done typing' } } });
		const done = await until(bob, (frame) => frame.method === 'message' && frame.params.body?.text === 'done typing');
		const relayed = done.skipped.filter((frame) => frame.method === 'activity');
		// Ten per minute in total: the first, then nine of the eleven.
		expect(relayed.map((frame) => frame.params.typing)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
		const mine = await until(alice, (frame) => frame.id === 'after');
		const notices = mine.skipped.filter((frame) => frame.method === 'message' && frame.params.from?.user_id === '@private');
		expect(notices).toHaveLength(1);
		// A private notice is never logged: no message_id or log_id (Appendix A.1).
		expect(notices[0].params).toEqual({ room_id: 'general', from: { user_id: '@private', name: 'Only you' }, body: { text: expect.stringContaining('Typing'), format: 'plain' } });
		expect(mine.skipped.filter((frame) => frame.method === 'activity')).toEqual([]);
		expect((await drain(carol)).filter((frame) => frame.method === 'activity')).toEqual([]);
		const history = await request(alice, 'history', 'history', { room_id: 'general', limit: 50 });
		const entries: Array<{ message_id: string; from?: { user_id: string } }> = history.result.messages;
		expect(entries.some((entry) => entry.message_id === mine.frame.result.message_id)).toBe(true);
		expect(entries.some((entry) => entry.from?.user_id?.startsWith('@'))).toBe(false);
	} finally { alice.close(); bob.close(); carol.close(); await configure((config) => { config.activityEnabled = false; }); }
});

it('answers /help with a private notice and rejects other commands without closing the socket', async () => {
	const peer = await connect();
	try {
		await authenticate(peer);
		const help = await exchange(peer, 'help', 'command', { body: { text: '/help' } });
		expect(help.frame.result).toEqual({});
		const notices = [...help.skipped, ...(await drain(peer))].filter((frame) => frame.method === 'message');
		expect(notices).toHaveLength(1);
		expect(notices[0].params).toEqual({
			room_id: 'general', from: { user_id: '@private', name: 'Only you' },
			body: { text: '- `/help`: list the commands you can use here', format: 'markdown' },
		});
		// Mistyped commands are ordinary errors, not policy violations.
		for (let index = 0; index < 4; index += 1) {
			const unknown = await request(peer, `unknown-${index}`, 'command', { room_id: 'general', body: { text: '/kick @someone' } });
			expect(unknown.error).toMatchObject({ code: -32602, message: 'Unknown command /kick; try /help' });
		}
		expect((await request(peer, 'saved', 'command', { message_id: '1', body: { text: '/help' } })).error.code).toBe(-32602);
		expect((await request(peer, 'still-open', 'me', {})).result.you).toBeTruthy();
		// Commands are never logged.
		const page = await request(peer, 'history', 'history', { limit: 50 });
		expect((page.result.messages ?? []).some((entry: { body?: { text?: string } }) => entry.body?.text?.startsWith('/'))).toBe(false);
	} finally { peer.close(); }
});

it('lists rooms by filter, most recently active first, with members on request, and throttles listing', async () => {
	const alice = await connect();
	const bob = await connect();
	try {
		const aliceId = await authenticate(alice);
		const bobId = await authenticate(bob);
		const threadIds: string[] = [];
		for (const title of ['Older', 'Newer']) {
			const created = await request(alice, `thread-${title}`, 'room_set', { parent_room_id: 'general', title });
			threadIds.push(created.result.room_id);
		}
		const [older, newer] = threadIds;
		// Activity in the older thread makes it the most recently active.
		await request(alice, 'bump', 'message', { room_id: older, body: { text: 'bump' } });
		await request(bob, 'join', 'room_join', { room_id: newer });

		// The first `filter: "joined"` listing after auth is not throttled.
		// With `members: true`, each room carries its members, bare and in
		// user_id order, and `users` their current objects, each once.
		const mine = (await request(alice, 'mine', 'room_list', { filter: 'joined', members: true })).result;
		expect(Object.keys(mine).sort()).toEqual(['joined', 'users']);
		expect(ids(mine.joined).slice(0, 2)).toEqual([older, newer]);
		expect(ids(mine.joined)).toContain('general');
		const general = mine.joined.find((room: { room_id: string }) => room.room_id === 'general');
		const generalIds = general.members.map((member: { user_id: string }) => member.user_id);
		expect(generalIds).toEqual(expect.arrayContaining([aliceId.user_id, bobId.user_id]));
		expect(generalIds).toEqual([...generalIds].sort());
		for (const member of general.members) expect(Object.keys(member)).toEqual(['user_id']);
		expect(mine.joined.find((room: { room_id: string }) => room.room_id === older).members).toEqual([{ user_id: aliceId.user_id }]);
		expect(mine.users).toEqual(expect.arrayContaining([aliceId, bobId]));
		const userIds = mine.users.map((user: { user_id: string }) => user.user_id);
		expect(userIds).toEqual([...new Set(userIds)].sort());
		expect(general.member_count).toBeUndefined();

		// Bob's threads: joined `newer`, and `older` to browse. Without
		// `members`, neither members nor users.
		const threads = (await request(bob, 'threads', 'room_list', { parent_room_id: 'general' })).result;
		expect(Object.keys(threads).sort()).toEqual(['joined', 'not_joined']);
		expect(ids(threads.joined)).toEqual([newer]);
		expect(ids(threads.not_joined)).toContain(older);
		expect(ids(threads.not_joined)).not.toContain('general');
		expect(threads.joined[0].members).toBeUndefined();
		// `filter` defaults to `all`; without parent_room_id, `not_joined`
		// holds only top-level rooms, and one asked for is present when empty.
		const top = (await request(bob, 'top', 'room_list', {})).result;
		expect(top.not_joined).toEqual([]);
		expect(ids(top.joined)).toEqual(expect.arrayContaining(['general', newer]));
		// One room, with its members, in the array its membership selects.
		const one = (await request(bob, 'one', 'room_list', { room_id: older, members: true })).result;
		expect(ids(one.not_joined)).toEqual([older]);
		expect(one.joined).toEqual([]);
		expect(one.not_joined[0].members).toEqual([{ user_id: aliceId.user_id }]);
		expect(one.users).toEqual([aliceId]);
		// `latest_log_id` is ignored, since guests' memberships are not logged:
		// the result is a full listing, without `left`.
		const since = (await request(alice, 'since', 'room_list', { filter: 'joined', latest_log_id: one.not_joined[0].latest_log_id })).result;
		expect(ids(since.joined)).toEqual(ids(mine.joined));
		expect(since.left).toBeUndefined();
		expect((await request(alice, 'missing', 'room_list', { room_id: 'missing' })).error.code).toBe(-32602);
		expect((await request(alice, 'bad-filter', 'room_list', { filter: 'mine' })).error.code).toBe(-32602);

		// Six listings a minute per user; the seventh waits. Alice has spent two
		// (`since`, and `missing`, which still read storage); the first joined
		// listing after auth was free, and a malformed one is not counted.
		for (let index = 0; index < 4; index += 1) {
			expect((await request(alice, `list-${index}`, 'room_list', { filter: 'joined' })).result.joined).toBeInstanceOf(Array);
		}
		const limited = (await request(alice, 'limited', 'room_list', { filter: 'joined' })).error;
		expect(limited.code).toBe(-32002);
		expect(limited.data.retry_after).toBeGreaterThan(0);
		// Browsing top-level rooms from general needs no listing and is not limited.
		expect((await request(alice, 'browse', 'room_list', { filter: 'not_joined' })).result).toEqual({ not_joined: [] });
		expect((await request(alice, 'browse-members', 'room_list', { filter: 'not_joined', members: true })).result).toEqual({ not_joined: [], users: [] });
	} finally { alice.close(); bob.close(); }
});

it('answers a guest re-auth on an authenticated connection without charging an attempt', async () => {
	const peer = await connect();
	try {
		const you = await authenticate(peer);
		// More than the per-IP attempt limit (10 a minute): none is charged.
		for (let index = 0; index < 12; index += 1) {
			peer.send({ id: `again-${index}`, method: 'auth', params: { scheme: 'guest' } });
			expect((await until(peer, (frame) => frame.id === `again-${index}`)).frame.result.you.user_id).toBe(you.user_id);
		}
	} finally { peer.close(); }
});

it('lists only connected guests as members after others posted and left', async () => {
	const alice = await connect();
	const leavers = await Promise.all([connect(), connect(), connect()]);
	try {
		const aliceId = await authenticate(alice);
		const gone: string[] = [];
		for (const [index, peer] of leavers.entries()) {
			gone.push((await authenticate(peer)).user_id);
			peer.send({ id: `post-${index}`, method: 'message', params: { room_id: 'general', body: { text: `leaving ${index}` } } });
			await until(peer, (frame) => frame.id === `post-${index}`);
			peer.close();
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
		// A fresh connection sees their messages in history, but not them as
		// members: a guest's membership ends with its connection, unlogged.
		const fresh = await connect();
		try {
			const freshId = await authenticate(fresh);
			fresh.send({ id: 'history', method: 'history', params: { room_id: 'general', limit: 50 } });
			const page = (await until(fresh, (frame) => frame.id === 'history')).frame.result;
			const senders = page.messages.map((entry: { from?: { user_id: string } }) => entry.from?.user_id);
			expect(senders).toEqual(expect.arrayContaining(gone));
			expect(page.membership).toBeUndefined();
			const members = (await request(fresh, 'list', 'room_list', { room_id: 'general', members: true })).result.joined[0].members.map((member: { user_id: string }) => member.user_id);
			expect(members).toEqual(expect.arrayContaining([aliceId.user_id, freshId.user_id]));
			for (const id of gone) expect(members).not.toContain(id);
		} finally { fresh.close(); }
	} finally { alice.close(); }
});

it('drops a connection that pinged and went quiet from room_list members and closes it', async () => {
	const alice = await connect();
	const bob = await connect();
	const carol = await connect();
	try {
		await authenticate(alice);
		const bobId = await authenticate(bob);
		const carolId = await authenticate(carol);
		await configure((config) => { config.limits.pingTimeoutSeconds = 1; });
		const closed = new Promise<number>((resolve) => bob.socket.addEventListener('close', (event) => resolve(event.code)));
		// The runtime answers the ping itself; it never reaches the handler.
		bob.socket.send('{"method":"ping"}');
		expect(await until(bob, (frame) => frame.method === 'pong')).toMatchObject({ frame: { method: 'pong' } });
		carol.socket.send('{"method":"ping"}');
		await until(carol, (frame) => frame.method === 'pong');
		await new Promise((resolve) => setTimeout(resolve, 700));
		// Carol keeps talking; Bob's peer has gone quiet.
		carol.socket.send('{"method":"ping"}');
		await until(carol, (frame) => frame.method === 'pong');
		await new Promise((resolve) => setTimeout(resolve, 500));

		const listed = (await request(alice, 'list', 'room_list', { room_id: 'general', members: true })).result.joined[0].members.map((member: { user_id: string }) => member.user_id);
		expect(listed).toContain(carolId.user_id);
		expect(listed).not.toContain(bobId.user_id);
		expect(await closed).toBe(1001);
	} finally { alice.close(); bob.close(); carol.close(); await configure((config) => { config.limits.pingTimeoutSeconds = 150; }); }
});

it('advertises the ping interval and the demo policy hints', async () => {
	const peer = await connect();
	try {
		const server = await peer.next();
		expect(server.params.ping).toBe(45);
		expect(server.params.ext.demo.keepalive_seconds).toBeUndefined();
		// Leaving rooms is supported, so the demo no longer says otherwise.
		expect(server.params.ext.demo.room_leave).toBeUndefined();
		expect(server.params.ext.demo.read_cursors).toBe(false);
		// Registered members listed per room in `members`, besides connected ones.
		expect(server.params.ext.demo.room_list_members).toBe(100);
	} finally { peer.close(); }
});

it('links message snapshots to the previous one with prev_log_id, and never reaction sets', async () => {
	const alice = await connect();
	try {
		await authenticate(alice);
		alice.send({ id: 'post', method: 'message', params: { room_id: 'general', body: { text: 'first' } } });
		const created = await until(alice, (frame) => frame.method === 'message');
		expect(created.frame.params.prev_log_id).toBeUndefined();
		const messageId = created.frame.params.message_id;
		alice.send({ id: 'edit', method: 'message', params: { message_id: messageId, room_id: 'general', body: { text: 'second' } } });
		const edited = await until(alice, (frame) => frame.method === 'message');
		expect(edited.frame.params.prev_log_id).toBe(messageId);
		alice.send({ id: 'react', method: 'reactions', params: { message_id: messageId, emojis: ['👍'] } });
		const reacted = await until(alice, (frame) => frame.method === 'reactions');
		expect(reacted.frame.params.prev_log_id).toBeUndefined();
		alice.send({ id: 'react-again', method: 'reactions', params: { message_id: messageId, emojis: ['👍', '🎉'] } });
		const again = await until(alice, (frame) => frame.method === 'reactions');
		// Only room records and message snapshots carry prev_log_id (§2).
		expect(again.frame.params.prev_log_id).toBeUndefined();
		// Walking back: a window bounded to prev_log_id returns that snapshot.
		const previous = await request(alice, 'previous', 'history', { after: edited.frame.params.prev_log_id, before: edited.frame.params.prev_log_id });
		expect(previous.result.messages).toEqual([created.frame.params]);
		expect([previous.result.first_log_id, previous.result.last_log_id, previous.result.more]).toEqual([messageId, messageId, false]);
	} finally { alice.close(); }
});

it('reserves frames in blocks per connection, never granting a block twice', async () => {
	const budget = () => runInDurableObject(env.DEMO.getByName('public-demo-v1'), (instance) =>
		(instance as unknown as { store: { budget(): { frames: number; writes: number } } }).store.budget());
	const peer = await connect();
	try {
		await peer.next(); // server announcement
		const before = await budget();
		// The first frame reserves a block of ten; the next nine spend it without SQL.
		peer.send({ id: 'auth', method: 'auth', params: { scheme: 'guest' } });
		await until(peer, (frame) => frame.id === 'auth');
		for (let index = 0; index < 9; index += 1) {
			peer.send({ id: `join-${index}`, method: 'room_join', params: { room_id: 'general' } });
			await until(peer, (frame) => frame.id === `join-${index}`);
		}
		const spent = await budget();
		expect(spent.frames - before.frames).toBe(10);
		// The eleventh frame needs a new block.
		peer.send({ id: 'join-last', method: 'room_join', params: { room_id: 'general' } });
		await until(peer, (frame) => frame.id === 'join-last');
		expect((await budget()).frames - before.frames).toBe(20);
	} finally { peer.close(); }
});

it('finishes auth before later frames: pipelined requests run as the new identity, or are denied behind a failed auth', async () => {
	// Sent together without waiting (§3.2): the listing and the history page
	// run after the guest auth completes.
	const peer = await connect();
	try {
		expect((await peer.next()).method).toBe('server');
		peer.send({ id: 'auth', method: 'auth', params: { scheme: 'guest' } });
		peer.send({ id: 'rooms', method: 'room_list', params: { filter: 'joined', members: true } });
		peer.send({ id: 'history', method: 'history', params: { limit: 1 } });
		const auth = await peer.next();
		expect(auth.id).toBe('auth');
		const rooms = await peer.next();
		expect(rooms.id).toBe('rooms');
		expect(ids(rooms.result.joined)).toEqual(['general']);
		expect(rooms.result.joined[0].members).toEqual(expect.arrayContaining([{ user_id: auth.result.you.user_id }]));
		expect(rooms.result.users).toEqual(expect.arrayContaining([auth.result.you]));
		const history = await peer.next();
		expect(history.id).toBe('history');
		expect(history.result.latest_log_id).toMatch(/^[1-9][0-9]*$/);
	} finally { peer.close(); }

	// A token resume awaits storage; the frames behind it wait for it, and
	// are denied when it fails.
	const failed = await connect();
	try {
		await failed.next();
		failed.send({ id: 'auth', method: 'auth', params: { scheme: 'token', token: 'no-such-session' } });
		failed.send({ id: 'rooms', method: 'room_list', params: { filter: 'joined' } });
		failed.send({ id: 'post', method: 'message', params: { body: { text: 'behind a failed auth' } } });
		const frames = [await failed.next(), await failed.next(), await failed.next()];
		expect(frames.map((frame) => frame.id)).toEqual(['auth', 'rooms', 'post']);
		for (const frame of frames) expect(frame.error.code).toBe(-32001);
	} finally { failed.close(); }

	// A WebAuthn begin step authenticates nothing, so requests behind it are denied.
	const begun = await connect();
	try {
		await begun.next();
		begun.send({ id: 'begin', method: 'auth', params: { scheme: 'webauthn', action: 'login', step: 'begin' } });
		begun.send({ id: 'rooms', method: 'room_list', params: { filter: 'joined' } });
		const challenge = await begun.next();
		expect(challenge.id).toBe('begin');
		expect(challenge.result.challenge_id).toBeTruthy();
		const denied = await begun.next();
		expect(denied.id).toBe('rooms');
		expect(denied.error.code).toBe(-32001);
	} finally { begun.close(); }
});

it('sends the notifications a request causes on its connection before its result', async () => {
	const alice = await connect();
	try {
		const you = await authenticate(alice);
		const post = await exchange(alice, 'post', 'message', { body: { text: 'ordered' } });
		expect(post.skipped.map((frame) => frame.method)).toEqual(['message']);
		expect(post.skipped[0].params.message_id).toBe(post.frame.result.message_id);
		const react = await exchange(alice, 'react', 'reactions', { message_id: post.frame.result.message_id, emojis: ['👍'] });
		expect(react.skipped).toEqual([{ method: 'reactions', params: expect.objectContaining({ message_id: post.frame.result.message_id, reactions: [{ from: you, emojis: ['👍'] }] }) }]);
		expect(react.frame.result).toEqual({});
		const thread = await exchange(alice, 'thread', 'room_set', { parent_room_id: 'general', title: 'Ordered' });
		expect(thread.skipped.map((frame) => frame.method)).toEqual(['room_update']);
		const roomId = thread.frame.result.room_id;
		const posted = await exchange(alice, 'in-thread', 'message', { room_id: roomId, body: { text: 'thread members only' } });
		expect(posted.skipped.map((frame) => frame.params.room_id)).toEqual([roomId]);
		const leave = await exchange(alice, 'leave', 'room_leave', { room_id: roomId });
		expect(leave.skipped).toEqual([{ method: 'room_update', params: { left: [{ room_id: roomId }] } }]);
		const join = await exchange(alice, 'join', 'room_join', { room_id: roomId });
		expect(join.skipped.map((frame) => Object.keys(frame.params))).toEqual([['joined', 'users']]);
		const help = await exchange(alice, 'help', 'command', { body: { text: '/help' } });
		expect(help.skipped).toEqual([{ method: 'message', params: expect.objectContaining({ from: { user_id: '@private', name: 'Only you' } }) }]);
	} finally { alice.close(); }
});

it('returns history in v6 shape: messages, first_log_id/last_log_id, and empty arrays omitted', async () => {
	const peer = await connect();
	try {
		await authenticate(peer);
		const created = await request(peer, 'thread', 'room_set', { parent_room_id: 'general', title: 'Shape' });
		const roomId = created.result.room_id;
		const only = (await request(peer, 'room-only', 'history', { room_id: roomId })).result;
		// Only a room record: no messages, reactions, or membership arrays.
		expect(Object.keys(only).sort()).toEqual(['first_log_id', 'history_log_id', 'last_log_id', 'latest_log_id', 'more', 'rooms']);
		expect([only.first_log_id, only.last_log_id]).toEqual([roomId, roomId]);
		const posted = await exchange(peer, 'post', 'message', { room_id: roomId, body: { text: 'shaped' } });
		const page = (await request(peer, 'after', 'history', { room_id: roomId, after: posted.frame.result.message_id })).result;
		expect(Object.keys(page).sort()).toEqual(['first_log_id', 'history_log_id', 'last_log_id', 'latest_log_id', 'messages', 'more']);
		expect(page.messages).toEqual([posted.skipped[0].params]);
		expect(page.entries).toBeUndefined();
		expect(page.users).toBeUndefined();
		// An empty slice: `more: false` and neither bound.
		const empty = (await request(peer, 'empty', 'history', { room_id: roomId, after: String(BigInt(page.last_log_id) + 1n) })).result;
		expect(empty).toEqual({ more: false, latest_log_id: page.latest_log_id, history_log_id: roomId });
	} finally { peer.close(); }
});
