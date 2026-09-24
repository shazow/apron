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

async function authenticate(peer: Awaited<ReturnType<typeof connect>>, scheme = 'guest', extraCaps: string[] = []) {
	const server = await peer.next();
	expect(server.method).toBe('server');
	expect(server.params.protocol).toBe(4);
	expect(server.params.caps).toEqual(['history', 'edit', 'rooms', 'reactions', ...extraCaps]);
	expect(server.params.auth).toContain('webauthn');
	expect(server.params.extensions).toBeUndefined();
	// Demo hints live under the standard ext object, not a top-level key.
	expect(server.params.ext.demo.retention_seconds).toBeGreaterThan(0);
	peer.send({ method: 'auth', id: 'auth', params: { scheme } });
	const auth = await peer.next();
	expect(auth.result.you.user_id).toMatch(/^guest_/);
	// Every visible room is announced; general is first.
	const room = await peer.next();
	expect(room.method).toBe('room');
	expect(room.params.room_id).toBe('general');
	expect(room.params.title).toBe('General');
	expect(room.params.log_id).toMatch(/^[1-9][0-9]*$/);
	expect(room.params.latest_log_id).toMatch(/^[1-9][0-9]*$/);
	expect(room.params.history_log_id).toMatch(/^[1-9][0-9]*$/);
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

/** Skip further room announcements that precede the next request's reply. */
async function reply(peer: Awaited<ReturnType<typeof connect>>, id: string): Promise<Frame> {
	return (await until(peer, frame => frame.id === id)).frame;
}

it('admits clients without Origin as guests without advertising or allowing passkeys', async () => {
	const peer = await connect(undefined, '/', null);
	try {
		expect((await peer.next()).params.auth).toEqual(['guest']);
		peer.send({ id: 'auth', method: 'auth', params: { scheme: 'guest' } });
		expect((await peer.next()).result.you.user_id).toMatch(/^guest_/);
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
		expect(server.params.auth).toEqual(['webauthn', 'token', 'guest']);

		peer.send({ id: 'auth', method: 'auth', params: { scheme: 'guest' } });
		const auth = await peer.next();
		publicFrames.push(auth);
		expectPublicFrame(auth);
		const room = await peer.next();
		publicFrames.push(room);
		expectPublicFrame(room);

		peer.send({ id: 'post', method: 'message', params: {
			room_id: 'general', body: { text: 'disclosure regression' }, ext: { demo: { ipKey: 'client-controlled' } },
		} });
		const saved = await reply(peer, 'post');
		publicFrames.push(saved);
		expectPublicFrame(saved);
		const broadcast = await peer.next();
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

it('commits once for canonical retries, passes ext through, and sends no reply to notifications', async () => {
	const peer = await connect();
	try {
		const you = await authenticate(peer);
		peer.send({ jsonrpc: '2.0', id: '', method: 'message', params: {
			room_id: 'general', body: { text: 'hello' }, ext: { z: 1, a: 2 }, from: { user_id: 'spoof' }, stray: true,
		} });
		const saved = await reply(peer, '');
		expect(saved.result.message_id).toMatch(/^[1-9][0-9]*$/);
		const broadcast = await peer.next();
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
		expect(page.result.entries).toEqual([broadcast.params]);
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
			const result = await writer.next();
			expect(result.result.message_id).toBeTruthy();
			if (i === 0) accepted = result.result;
			expect((await writer.next()).method).toBe('message');
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
		expect((await peer.next()).method).toBe('room');
		expect((await peer.next()).id).toBe('m');
		expect((await peer.next()).method).toBe('message');
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

// Tests below create thread rooms, which every later authentication announces.

it('rejects requests without a room and operations guests may not perform', async () => {
	// Three invalid requests within a minute close a socket, so spread them.
	const peer = await connect();
	const other = await connect();
	try {
		await authenticate(peer);
		await authenticate(other);
		peer.send({ id: 'no-room', method: 'message', params: { body: { text: 'where?' } } });
		expect((await peer.next()).error.code).toBe(-32602);
		peer.send({ id: 'no-room-history', method: 'history', params: { limit: 5 } });
		expect((await peer.next()).error.code).toBe(-32602);
		peer.send({ id: 'top-level', method: 'room', params: { title: 'Top level' } });
		expect((await peer.next()).error.code).toBe(-32001);
		peer.send({ id: 'leave', method: 'room_leave', params: { room_id: 'general' } });
		expect((await peer.next()).error.code).toBe(-32001);
		// Guests keep their assigned name.
		peer.send({ id: 'rename', method: 'me', params: { name: 'Ada' } });
		expect((await peer.next()).error.code).toBe(-32001);
		other.send({ id: 'unknown-history', method: 'history', params: { room_id: 'missing' } });
		expect((await other.next()).error.code).toBe(-32602);
		other.send({ id: 'join-missing', method: 'room_join', params: { room_id: 'missing' } });
		expect((await other.next()).error.code).toBe(-32602);
	} finally { peer.close(); other.close(); }
});

it('creates threads, moves messages into them, and delivers reactions to every client', async () => {
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

		alice.send({ id: 'post', method: 'message', params: { room_id: 'general', body: { text: 'belongs in a thread' } } });
		const messageId = (await reply(alice, 'post')).result.message_id;
		const original = await both('message');

		bob.send({ id: 'react', method: 'reactions', params: { message_id: messageId, emojis: ['👍', '👍'] } });
		expect((await reply(bob, 'react')).result).toEqual({});
		const reaction = await both('reactions');
		expect(reaction).toEqual({
			log_id: reaction.log_id, message_id: messageId, room_id: 'general',
			reactions: [{ from: bobId, emojis: ['👍'] }],
		});
		bob.send({ id: 'react-missing', method: 'reactions', params: { message_id: '404', emojis: ['👍'] } });
		expect((await reply(bob, 'react-missing')).error.code).toBe(-32602);

		alice.send({ id: 'thread', method: 'room', params: { parent_room_id: 'general', title: 'Deploy', intro_message: { message_id: messageId } } });
		const roomId = (await reply(alice, 'thread')).result.room_id;
		const room = await both('room');
		expect(room).toEqual({
			room_id: roomId, log_id: roomId, parent_room_id: 'general', title: 'Deploy',
			intro_message: original, latest_log_id: roomId, history_log_id: roomId,
		});

		alice.send({ id: 'move', method: 'message', params: { message_id: messageId, room_id: roomId, body: { text: 'moved' }, reply_to: { message_id: messageId } } });
		expect((await reply(alice, 'move')).error.code).toBe(-32602);
		alice.send({ id: 'move-2', method: 'message', params: { message_id: messageId, room_id: roomId, body: { text: 'moved' } } });
		expect((await reply(alice, 'move-2')).result).toEqual({ message_id: messageId });
		const moved = await both('message');
		expect(moved).toMatchObject({ message_id: messageId, room_id: roomId, from: aliceId, body: { text: 'moved' } });
		const followed = await both('reactions');
		expect(followed).toMatchObject({ message_id: messageId, room_id: roomId, reactions: [{ from: bobId, emojis: ['👍'] }] });
		expect(BigInt(followed.log_id)).toBeGreaterThan(BigInt(moved.log_id));

		bob.send({ id: 'general-history', method: 'history', params: { room_id: 'general', after: original.log_id } });
		const general = (await reply(bob, 'general-history')).result;
		expect(general.entries.map((entry: any) => [entry.log_id, entry.room_id])).toEqual([[original.log_id, 'general'], [moved.log_id, roomId]]);
		expect(general.reactions).toEqual([reaction]);
		bob.send({ id: 'thread-history', method: 'history', params: { room_id: roomId } });
		const thread = (await reply(bob, 'thread-history')).result;
		// History room records carry the room's current delivery fields.
		expect(thread.rooms).toEqual([{ ...room, latest_log_id: followed.log_id }]);
		expect(thread.entries).toEqual([moved]);
		expect(thread.reactions).toEqual([followed]);
		expect([thread.first_id, thread.last_id, thread.more]).toEqual([roomId, followed.log_id, false]);
		expect([thread.latest_log_id, thread.history_log_id]).toEqual([followed.log_id, roomId]);

		bob.send({ id: 'rename', method: 'room', params: { room_id: roomId, title: 'Deploys', parent_room_id: 'ignored' } });
		expect((await reply(bob, 'rename')).result).toEqual({ room_id: roomId });
		const renamed = await both('room');
		expect(renamed).toMatchObject({ room_id: roomId, parent_room_id: 'general', title: 'Deploys' });
		expect(renamed.intro_message).toBeUndefined();

		bob.send({ id: 'join', method: 'room_join', params: { room_id: roomId } });
		expect((await reply(bob, 'join')).result).toEqual({});
		expect((await bob.next())).toEqual({ method: 'room', params: renamed });
	} finally { alice.close(); bob.close(); }

	// A later session is told about the thread right after general.
	const late = await connect();
	try {
		await authenticate(late);
		const announcement = await late.next();
		expect(announcement.method).toBe('room');
		expect(announcement.params.parent_room_id).toBe('general');
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
			peer.send({ id: `list-${index}`, method: 'room_list', params: {} });
			expect((await until(peer, (frame) => frame.id === `list-${index}`)).frame.result.rooms).toHaveLength(1);
		}
		peer.send({ id: 'busy', method: 'room_list', params: {} });
		const busy = (await until(peer, (frame) => frame.id === 'busy')).frame.error;
		expect(busy.code).toBe(-32002);
		expect(busy.data.retry_after).toBeGreaterThan(0);
		// The socket stays open and a later minute is served again.
		await configure((config) => { config.limits.globalFramesPerMinute = 300; });
		peer.send({ id: 'again', method: 'room_list', params: {} });
		expect((await until(peer, (frame) => frame.id === 'again')).frame.result.rooms).toHaveLength(1);
	} finally { peer.close(); await configure((config) => { config.limits.globalFramesPerMinute = 300; }); }
});

it('with ACTIVITY on, relays typing without read cursors, throttles it per user, and tells only the sender once', async () => {
	await configure((config) => { config.activityEnabled = true; });
	const alice = await connect();
	const bob = await connect();
	try {
		const aliceId = await authenticate(alice, 'guest', ['activity']);
		await authenticate(bob, 'guest', ['activity']);
		alice.send({ method: 'activity', params: { room_id: 'general', typing: 99 } });
		const first = await until(bob, (frame) => frame.method === 'activity');
		// Typing is capped by policy; the sender's own connection is not echoed.
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
		const notices = mine.skipped.filter((frame) => frame.method === 'message' && frame.params.from?.user_id === '@server');
		expect(notices).toHaveLength(1);
		expect(notices[0].params).toMatchObject({ room_id: 'general', from: { user_id: '@server', name: 'Server' }, body: { format: 'plain' } });
		expect(notices[0].params.message_id).toBe(notices[0].params.log_id);
		expect(mine.skipped.filter((frame) => frame.method === 'activity')).toEqual([]);
		// The notice is never logged, and later records still sort after it.
		expect(BigInt(mine.frame.result.message_id)).toBeGreaterThan(BigInt(notices[0].params.log_id));
		alice.send({ id: 'history', method: 'history', params: { room_id: 'general', limit: 50 } });
		const history = await until(alice, (frame) => frame.id === 'history');
		// History entries are flat message snapshots. The page holds Alice's post, so
		// the check below is not passing on an empty or misread page.
		const entries: Array<{ message_id: string; from?: { user_id: string } }> = history.frame.result.entries;
		expect(entries.some((entry) => entry.message_id === mine.frame.result.message_id)).toBe(true);
		expect(entries.some((entry) => entry.from?.user_id === '@server' || entry.message_id === notices[0].params.message_id)).toBe(false);
	} finally { alice.close(); bob.close(); await configure((config) => { config.activityEnabled = false; }); }
});

it('lists rooms and threads with the connected members, and throttles listing', async () => {
	const alice = await connect();
	const bob = await connect();
	try {
		const aliceId = await authenticate(alice);
		const bobId = await authenticate(bob);
		alice.send({ id: 'post', method: 'message', params: { room_id: 'general', body: { text: 'thread root' } } });
		const post = await until(alice, (frame) => frame.id === 'post');
		alice.send({ id: 'thread', method: 'room', params: { parent_room_id: 'general', title: 'Listed', intro_message: { message_id: post.frame.result.message_id } } });
		const thread = (await until(alice, (frame) => frame.id === 'thread')).frame.result.room_id;

		alice.send({ id: 'top', method: 'room_list', params: {} });
		const top = (await until(alice, (frame) => frame.id === 'top')).frame.result.rooms;
		expect(top.map((room: { room_id: string }) => room.room_id)).toEqual(['general']);
		const members = top[0].members.map((member: { user_id: string }) => member.user_id);
		expect(members).toEqual(expect.arrayContaining([aliceId.user_id, bobId.user_id]));
		alice.send({ id: 'threads', method: 'room_list', params: { parent_room_id: 'general' } });
		const threads = (await until(alice, (frame) => frame.id === 'threads')).frame.result.rooms;
		expect(threads.map((room: { room_id: string }) => room.room_id)).toContain(thread);
		expect(threads.find((room: { room_id: string }) => room.room_id === thread)).toMatchObject({ parent_room_id: 'general', title: 'Listed' });
		alice.send({ id: 'missing', method: 'room_list', params: { parent_room_id: 'missing' } });
		expect((await until(alice, (frame) => frame.id === 'missing')).frame.error.code).toBe(-32602);
		// Six listings a minute per user; the seventh waits.
		for (let index = 0; index < 3; index += 1) {
			alice.send({ id: `list-${index}`, method: 'room_list', params: {} });
			expect((await until(alice, (frame) => frame.id === `list-${index}`)).frame.result.rooms).toHaveLength(1);
		}
		alice.send({ id: 'limited', method: 'room_list', params: {} });
		const limited = (await until(alice, (frame) => frame.id === 'limited')).frame.error;
		expect(limited.code).toBe(-32002);
		expect(limited.data.retry_after).toBeGreaterThan(0);
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
		// A fresh connection sees their messages in history, but not them as members.
		const fresh = await connect();
		try {
			const freshId = await authenticate(fresh);
			fresh.send({ id: 'history', method: 'history', params: { room_id: 'general', limit: 50 } });
			const senders = (await until(fresh, (frame) => frame.id === 'history')).frame.result.entries.map((entry: { from?: { user_id: string } }) => entry.from?.user_id);
			expect(senders).toEqual(expect.arrayContaining(gone));
			fresh.send({ id: 'list', method: 'room_list', params: {} });
			const members = (await until(fresh, (frame) => frame.id === 'list')).frame.result.rooms[0].members.map((member: { user_id: string }) => member.user_id);
			expect(members).toEqual(expect.arrayContaining([aliceId.user_id, freshId.user_id]));
			for (const id of gone) expect(members).not.toContain(id);
		} finally { fresh.close(); }
	} finally { alice.close(); }
});

it('drops a quiet keepalive connection from room_list members and closes it', async () => {
	const alice = await connect();
	const bob = await connect();
	const carol = await connect();
	try {
		await authenticate(alice);
		const bobId = await authenticate(bob);
		const carolId = await authenticate(carol);
		await configure((config) => { config.limits.keepaliveTimeoutSeconds = 1; });
		const closed = new Promise<number>((resolve) => bob.socket.addEventListener('close', (event) => resolve(event.code)));
		// The runtime answers the keepalive itself; it never reaches the handler.
		bob.socket.send('{"method":"ping"}');
		expect(await until(bob, (frame) => frame.method === 'pong')).toMatchObject({ frame: { method: 'pong' } });
		carol.socket.send('{"method":"ping"}');
		await until(carol, (frame) => frame.method === 'pong');
		await new Promise((resolve) => setTimeout(resolve, 700));
		// Carol keeps talking; Bob's peer has gone quiet.
		carol.socket.send('{"method":"ping"}');
		await until(carol, (frame) => frame.method === 'pong');
		await new Promise((resolve) => setTimeout(resolve, 500));

		alice.send({ id: 'list', method: 'room_list', params: {} });
		const listed = (await until(alice, (frame) => frame.id === 'list')).frame.result.rooms[0].members.map((member: { user_id: string }) => member.user_id);
		expect(listed).toContain(carolId.user_id);
		expect(listed).not.toContain(bobId.user_id);
		expect(await closed).toBe(1001);
	} finally { alice.close(); bob.close(); carol.close(); await configure((config) => { config.limits.keepaliveTimeoutSeconds = 150; }); }
});

it('advertises the keepalive interval', async () => {
	const peer = await connect();
	try {
		const server = await peer.next();
		expect(server.params.ext.demo.keepalive_seconds).toBe(45);
	} finally { peer.close(); }
});

it('links each changed record to the previous one with prev_log_id', async () => {
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
		expect(again.frame.params.prev_log_id).toBe(reacted.frame.params.log_id);
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
