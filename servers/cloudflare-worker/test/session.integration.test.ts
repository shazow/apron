import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';

type Frame = { id?: string | null; method?: string; result?: any; error?: any; params?: any };
let nextIp = 40;

type StoredSessionTest = { v: 1; userId: string; origin: string; expiresMs: number };

async function sweepSessions(now: number): Promise<void> {
	await runInDurableObject(stub(), async (instance) => {
		await (instance as unknown as { sweepSessions(now: number): Promise<void> }).sweepSessions(now);
	});
}

async function connect(origin: string | null = 'http://localhost:5173', ip = `192.0.2.${nextIp++}`) {
	const response = await SELF.fetch('https://demo.test/ws', { headers: {
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
		send(frame: unknown) { socket.send(JSON.stringify(frame)); },
		next(): Promise<Frame> {
			const frame = frames.shift();
			return frame ? Promise.resolve(frame) : new Promise(resolve => waiters.push(resolve));
		},
		close() { socket.close(1000, 'test complete'); }
	};
}

const stub = () => env.DEMO.getByName('public-demo-v1');
const isolatedStub = () => env.DEMO.getByName(`session-cleanup-${crypto.randomUUID()}`);

async function sweepOn(target: ReturnType<typeof env.DEMO.getByName>, now: number): Promise<void> {
	await runInDurableObject(target, async (instance) => {
		await (instance as unknown as { sweepSessions(now: number): Promise<void> }).sweepSessions(now);
	});
}

/** Registers an identity straight into the object's store, bypassing the ceremony. */
async function registerIdentity(userId: string, ipKey = 'session-test-ip'): Promise<void> {
	await runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as { store: { registerIdentity(input: Record<string, unknown>): unknown } };
		runtime.store.registerIdentity({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
	});
}

/** Registers an identity that starts in the given rooms, as a guest registering on its connection does. */
async function registerIdentityIn(userId: string, rooms: string[]): Promise<string[]> {
	return runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as { store: { registerIdentity(input: Record<string, unknown>): { rooms: string[] } } };
		return runtime.store.registerIdentity({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 }, rooms,
		}).rooms;
	});
}

async function issueSession(userId: string, origin: string): Promise<string> {
	return runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as { issueSession(userId: string, origin: string, now: number): Promise<string> };
		return runtime.issueSession(userId, origin, Date.now());
	});
}

it('resumes passkey sessions only where passkeys are offered; bot tokens work anywhere', async () => {
	const trusted = await connect();
	expect((await trusted.next()).params.auth).toEqual(['webauthn', 'token', 'guest']);
	trusted.close();
	// `token` is offered without an Origin too, for bot tokens (/invite-bot).
	await registerIdentity('user_session_elsewhere', 'session-elsewhere-ip');
	const session = await issueSession('user_session_elsewhere', 'http://localhost:5173');
	const untrusted = await connect(null);
	expect((await untrusted.next()).params.auth).toEqual(['token', 'guest']);
	untrusted.send({ id: 't', method: 'auth', params: { scheme: 'token', token: 'anything' } });
	expect((await untrusted.next()).error.code).toBe(-32001);
	untrusted.send({ id: 's', method: 'auth', params: { scheme: 'token', token: session } });
	expect((await untrusted.next()).error.code).toBe(-32001);
	untrusted.close();
});

it('resumes a registered identity from a session token, renews it, and rejects bad tokens', async () => {
	await registerIdentity('user_session_one');
	const token = await issueSession('user_session_one', 'http://localhost:5173');

	const peer = await connect();
	await peer.next();
	peer.send({ id: 'bad', method: 'auth', params: { scheme: 'token', token: 'not-a-session' } });
	const denied = await peer.next();
	expect(denied.id).toBe('bad');
	expect(denied.error.code).toBe(-32001);

	peer.send({ id: 'resume', method: 'auth', params: { scheme: 'token', token } });
	const resumed = await peer.next();
	expect(resumed.id).toBe('resume');
	expect(resumed.result.you).toEqual(expect.objectContaining({ user_id: 'user_session_one', name: 'Name of user_session_one' }));
	expect(resumed.result.token).toBe(token);

	// A registered connection cannot switch identities in place.
	peer.send({ id: 'again', method: 'auth', params: { scheme: 'token', token } });
	expect((await peer.next()).error.code).toBe(-32001);
	peer.close();

	// A fresh session still has most of its lifetime: the resume left it as is.
	const expiresMs = await runInDurableObject(stub(), async (_instance, state) => {
		const sessions = await state.storage.list<{ userId: string; expiresMs: number }>({ prefix: 'session:' });
		return [...sessions.values()].find((session) => session.userId === 'user_session_one')!.expiresMs;
	});
	expect(expiresMs).toBeGreaterThan(Date.now() + 11 * 60 * 60 * 1000);
	// Simulate a crash between writing a renewed session and removing its old
	// index row. Cleanup must discard the stale due row while preserving the
	// still-live authoritative session.
	await runInDurableObject(stub(), async (_instance, state) => {
		const entries = await state.storage.list<{ sessionKey: string; expiresMs: number }>({ prefix: 'session-expiry:' });
		const current = [...entries].find(([, entry]) => entry.expiresMs === expiresMs);
		expect(current).toBeDefined();
		const [, entry] = current!;
		await state.storage.put(`session-expiry:${(Date.now() - 1).toString().padStart(16, '0')}:${entry.sessionKey.slice('session:'.length)}`, {
			...entry, expiresMs: Date.now() - 1,
		});
	});
	const racePeer = await connect();
	await racePeer.next();
	racePeer.send({ id: 'race-resume', method: 'auth', params: { scheme: 'token', token } });
	const [raceResumed] = await Promise.all([racePeer.next(), sweepSessions(Date.now() + 1)]);
	expect(raceResumed.result.you.user_id).toBe('user_session_one');
	racePeer.close();
	const sessionStillLive = await runInDurableObject(stub(), async (_instance, state) => {
		const index = await state.storage.list<{ expiresMs: number }>({ prefix: 'session-expiry:' });
		expect([...index.values()].every((entry) => entry.expiresMs > Date.now())).toBe(true);
		const sessions = await state.storage.list<StoredSessionTest>({ prefix: 'session:' });
		return [...sessions.values()].some((session) => session.userId === 'user_session_one' && session.expiresMs > Date.now());
	});
	expect(sessionStillLive).toBe(true);
});

it('renews a resumed session only once less than half its lifetime remains', async () => {
	await registerIdentity('user_session_renew', 'session-renew-ip');
	const token = await issueSession('user_session_renew', 'http://localhost:5173');
	const stored = () => runInDurableObject(stub(), async (_instance, state) => {
		const sessions = await state.storage.list<StoredSessionTest>({ prefix: 'session:' });
		const index = await state.storage.list<{ sessionKey: string; expiresMs: number }>({ prefix: 'session-expiry:' });
		const [key, session] = [...sessions].find(([, value]) => value.userId === 'user_session_renew')!;
		return { key, session, indexed: [...index.values()].filter((entry) => entry.sessionKey === key).map((entry) => entry.expiresMs) };
	});
	const resume = async () => {
		const peer = await connect();
		await peer.next();
		peer.send({ id: 'resume', method: 'auth', params: { scheme: 'token', token } });
		expect((await peer.next()).result.you.user_id).toBe('user_session_renew');
		peer.close();
	};

	const issued = await stored();
	await resume();
	// Most of the lifetime remains: nothing is rewritten.
	expect(await stored()).toEqual(issued);

	// Two hours left: the resume renews it and moves its index entry.
	const soon = Date.now() + 2 * 60 * 60 * 1000;
	await runInDurableObject(stub(), async (_instance, state) => {
		await state.storage.put(issued.key, { ...issued.session, expiresMs: soon });
		for (const [indexKey, entry] of await state.storage.list<{ sessionKey: string }>({ prefix: 'session-expiry:' })) {
			if (entry.sessionKey === issued.key) await state.storage.delete(indexKey);
		}
		await state.storage.put(`session-expiry:${soon.toString().padStart(16, '0')}:${issued.key.slice('session:'.length)}`, { v: 1, sessionKey: issued.key, expiresMs: soon });
	});
	await resume();
	const renewed = await stored();
	expect(renewed.session.expiresMs).toBeGreaterThan(Date.now() + 11 * 60 * 60 * 1000);
	expect(renewed.indexed).toEqual([renewed.session.expiresMs]);
});

it('binds sessions to their origin and drops expired ones on the alarm', async () => {
	await registerIdentity('user_session_two');
	const token = await issueSession('user_session_two', 'https://other.example');
	const peer = await connect();
	await peer.next();
	peer.send({ id: 'cross', method: 'auth', params: { scheme: 'token', token } });
	expect((await peer.next()).error.code).toBe(-32001);
	peer.close();

	await runInDurableObject(stub(), async (instance, state) => {
		const sessions = await state.storage.list<{ userId: string; expiresMs: number }>({ prefix: 'session:' });
		for (const [key, session] of sessions) {
			if (session.userId === 'user_session_two') {
				const expiredMs = Date.now() - 1;
				await state.storage.put(key, { ...session, expiresMs: expiredMs });
				const index = await state.storage.list<{ sessionKey: string }>({ prefix: 'session-expiry:' });
				for (const [indexKey, entry] of index) if (entry.sessionKey === key) {
					await state.storage.delete(indexKey);
					const suffix = key.slice('session:'.length);
					await state.storage.put(`session-expiry:${Math.max(0, expiredMs).toString().padStart(16, '0')}:${suffix}`, { ...entry, expiresMs: expiredMs });
				}
			}
		}
		await (instance as unknown as { sweepSessions(now: number): Promise<void> }).sweepSessions(Date.now());
		const remaining = await state.storage.list<{ userId: string }>({ prefix: 'session:' });
		expect([...remaining.values()].some((session) => session.userId === 'user_session_two')).toBe(false);
	});
});

it('denies a session token whose identity no longer exists without recreating it', async () => {
	// A storage reset wipes identities; a token that outlives its identity must
	// fall back to sign-in rather than crash or resurrect the account.
	const token = await issueSession('user_session_gone', 'http://localhost:5173');
	const peer = await connect();
	await peer.next();
	peer.send({ id: 'orphan', method: 'auth', params: { scheme: 'token', token } });
	const denied = await peer.next();
	expect(denied.id).toBe('orphan');
	expect(denied.error.code).toBe(-32001);
	// The connection stays usable as a guest.
	peer.send({ id: 'guest', method: 'auth', params: { scheme: 'guest' } });
	expect((await peer.next()).result.you.user_id).toMatch(/^guest_/);
	peer.close();
	const after = await runInDurableObject(stub(), async (instance, state) => ({
		identity: (instance as unknown as { store: { getIdentity(id: string): unknown } }).store.getIdentity('user_session_gone'),
		session: [...(await state.storage.list<StoredSessionTest>({ prefix: 'session:' })).values()].some((session) => session.userId === 'user_session_gone'),
	}));
	expect(after).toEqual({ identity: null, session: false });
});

it('updates a registered name with me, declines avatar and ext, and treats name as unknown', async () => {
	await registerIdentity('user_session_me');
	const token = await issueSession('user_session_me', 'http://localhost:5173');
	const peer = await connect();
	await peer.next();
	peer.send({ id: 'resume', method: 'auth', params: { scheme: 'token', token } });
	expect((await peer.next()).result.you.user_id).toBe('user_session_me');
	const reply = async (id: string): Promise<Frame> => {
		for (;;) {
			const frame = await peer.next();
			if (frame.id === id) return frame;
		}
	};

	peer.send({ id: 'rename', method: 'me', params: { name: 'Ada' } });
	expect((await reply('rename')).result).toEqual({ you: { user_id: 'user_session_me', name: 'Ada' } });
	// Omitted fields stay unchanged; the demo keeps no avatars or profile ext.
	peer.send({ id: 'profile', method: 'me', params: { avatar: 'https://example.test/a.png', ext: { demo: true } } });
	expect((await reply('profile')).result).toEqual({ you: { user_id: 'user_session_me', name: 'Ada' } });
	peer.send({ id: 'bad-avatar', method: 'me', params: { avatar: 7 } });
	expect((await reply('bad-avatar')).error.code).toBe(-32602);
	// An empty name removes it, so clients fall back to the user_id.
	// It is announced as its empty value (§3.3).
	peer.send({ id: 'clear', method: 'me', params: { name: '' } });
	expect((await reply('clear')).result).toEqual({ you: { user_id: 'user_session_me', name: '' } });
	peer.send({ id: 'unchanged', method: 'me', params: {} });
	expect((await reply('unchanged')).result).toEqual({ you: { user_id: 'user_session_me' } });
	peer.close();

	// The removal is durable: a later resume carries no name either.
	const again = await connect();
	await again.next();
	again.send({ id: 'resume', method: 'auth', params: { scheme: 'token', token } });
	expect((await again.next()).result.you).toEqual({ user_id: 'user_session_me' });
	again.close();
});

it('stops session cleanup safely when the maintenance budget is exhausted', async () => {
	const now = Date.now();
	const target = isolatedStub();
	await runInDurableObject(target, async (instance, state) => {
		await state.storage.put<StoredSessionTest>('session:budget-expired', {
			v: 1, userId: 'budget-expired', origin: 'http://localhost:5173', expiresMs: now - 1,
		});
		await state.storage.put(`session-expiry:${(now - 1).toString().padStart(16, '0')}:budget-expired`, {
			v: 1, sessionKey: 'session:budget-expired', expiresMs: now - 1,
		});
		const day = new Date(now).toISOString().slice(0, 10);
		state.storage.sql.exec(
			'UPDATE resource_budgets SET maintenance_reads = 100000000, maintenance_writes = 100000000 WHERE day = ?', day,
		);
		// The object was initialized before the direct SQL fixture update; force
		// the Store to reload the durable budget row on the next reservation.
		const store = (instance as unknown as { store: Record<string, unknown> }).store;
		store.budgetCache = null;
		store.budgetCacheDay = null;
		store.budgetHandoverPending = true;
	});
	await expect(sweepOn(target, now)).rejects.toMatchObject({ code: 'retry_after' });
	const state = await runInDurableObject(target, async (_instance, durableState) => ({
		remaining: [...(await durableState.storage.list<StoredSessionTest>({ prefix: 'session:' })).values()].filter((session) => session.userId === 'budget-expired').length,
		indexed: (await durableState.storage.list({ prefix: 'session-expiry:' })).size,
	}));
	// Exhaustion leaves the expired session and its index row for a later alarm.
	expect(state).toEqual({ remaining: 1, indexed: 1 });
});

it('keeps concurrent async reservations isolated from unrelated SQL work', async () => {
	const target = isolatedStub();
	await runInDurableObject(target, async (instance) => {
		const store = (instance as unknown as {
			store: {
				withMeterAsync<T>(kind: 'foreground' | 'maintenance', cost: { reads: number; writes: number }, fn: () => Promise<T>): Promise<T>;
				getRoomState(): unknown;
				accountingStatus(): { unsafe: boolean };
			};
		}).store;
		await Promise.all([
			store.withMeterAsync('foreground', { reads: 1, writes: 1 }, async () => {
				await Promise.resolve();
				store.getRoomState();
				return 'foreground';
			}),
			store.withMeterAsync('maintenance', { reads: 1, writes: 1 }, async () => {
				await Promise.resolve();
				store.getRoomState();
				return 'maintenance';
			}),
		]);
		expect(store.accountingStatus().unsafe).toBe(false);
	});
});

it('sends user notifications for renames and for a guest signing in on its connection', async () => {
	await registerIdentity('user_session_notify', 'session-notify-ip');
	const token = await issueSession('user_session_notify', 'http://localhost:5173');
	const watcher = await connect();
	const tab = await connect();
	const second = await connect();
	const until = async (peer: Awaited<ReturnType<typeof connect>>, match: (frame: Frame) => boolean): Promise<Frame> => {
		for (;;) {
			const frame = await peer.next();
			if (match(frame)) return frame;
		}
	};
	try {
		for (const peer of [watcher, tab, second]) await peer.next();
		watcher.send({ id: 'guest', method: 'auth', params: { scheme: 'guest' } });
		await until(watcher, (frame) => frame.id === 'guest');
		tab.send({ id: 'guest', method: 'auth', params: { scheme: 'guest' } });
		const guest = (await until(tab, (frame) => frame.id === 'guest')).result.you;
		// Signing in on a guest's connection retires the guest for everyone else.
		tab.send({ id: 'resume', method: 'auth', params: { scheme: 'token', token } });
		expect((await until(tab, (frame) => frame.id === 'resume')).result.you.user_id).toBe('user_session_notify');
		expect((await until(watcher, (frame) => frame.method === 'user')).params).toEqual({ new: { user_id: 'user_session_notify', name: 'Name of user_session_notify' }, old: guest });

		second.send({ id: 'resume', method: 'auth', params: { scheme: 'token', token } });
		await until(second, (frame) => frame.id === 'resume');
		tab.send({ id: 'rename', method: 'me', params: { name: 'Notified' } });
		await until(tab, (frame) => frame.id === 'rename');
		expect((await until(second, (frame) => frame.method === 'user')).params).toEqual({ you: { user_id: 'user_session_notify', name: 'Notified' } });
		expect((await until(watcher, (frame) => frame.method === 'user')).params).toEqual({ new: { user_id: 'user_session_notify', name: 'Notified' } });
	} finally { watcher.close(); tab.close(); second.close(); }
});

it('does not count a closing connection against the per-user limit on resume', async () => {
	const userId = 'user_session_capacity';
	await registerIdentity(userId, 'session-capacity-ip');
	const token = await issueSession(userId, 'http://localhost:5173');
	const resume = async (id: string) => {
		const peer = await connect();
		await peer.next();
		peer.send({ id, method: 'auth', params: { scheme: 'token', token } });
		return { peer, reply: await peer.next() };
	};
	const open = [];
	for (const id of ['one', 'two', 'three']) {
		const { peer, reply } = await resume(id);
		expect(reply.result.you.user_id).toBe(userId);
		open.push(peer);
	}
	const refused = await resume('four');
	expect(refused.reply.error).toEqual(expect.objectContaining({ code: -32002, message: 'Demo capacity reached' }));
	refused.peer.close();

	// One of them dropped and its close is on the way: its replacement resumes.
	await runInDurableObject(stub(), async (instance) => {
		const sockets = (instance as unknown as { ctx: DurableObjectState }).ctx.getWebSockets();
		const dropped = sockets.find((socket) => (socket.deserializeAttachment() as { userId?: string } | null)?.userId === userId)!;
		dropped.serializeAttachment({ ...(dropped.deserializeAttachment() as object), closing: true });
	});
	const replacement = await resume('replacement');
	expect(replacement.reply.result.you.user_id).toBe(userId);
	replacement.peer.close();
	for (const peer of open) peer.close();
});

it('logs a registered user\'s joins and leaves as memberships, delivered around the change and kept in history', async () => {
	const userId = 'user_session_rooms';
	const name = `Name of ${userId}`;
	// A registration keeps the rooms a guest had joined that still exist.
	expect(await registerIdentityIn(userId, ['general', 'no-such-room'])).toEqual(['general']);
	const token = await issueSession(userId, 'http://localhost:5173');
	const until = async (peer: Awaited<ReturnType<typeof connect>>, match: (frame: Frame) => boolean): Promise<{ frame: Frame; skipped: Frame[] }> => {
		const skipped: Frame[] = [];
		for (;;) {
			const frame = await peer.next();
			if (match(frame)) return { frame, skipped };
			skipped.push(frame);
		}
	};
	const request = async (peer: Awaited<ReturnType<typeof connect>>, id: string, method: string, params: unknown) => {
		peer.send({ id, method, params });
		return until(peer, (frame) => frame.id === id);
	};
	const resume = async () => {
		const peer = await connect();
		await peer.next();
		expect((await request(peer, 'resume', 'auth', { scheme: 'token', token })).frame.result.you.user_id).toBe(userId);
		return peer;
	};
	const joinedIds = async (peer: Awaited<ReturnType<typeof connect>>) =>
		(await request(peer, 'mine', 'room_list', { filter: 'joined' })).frame.result.joined.map((room: { room_id: string }) => room.room_id);
	const methods = (frames: Frame[]) => frames.map((frame) => frame.method);
	const membership = (roomId: string, joined: boolean) => ({
		method: 'membership', params: { log_id: expect.stringMatching(/^[1-9][0-9]*$/), room_id: roomId, members: [{ user: { user_id: userId, name }, joined }] },
	});
	const tab = await resume();
	const other = await resume();
	const reader = await connect();
	let threadId: string;
	try {
		await reader.next();
		const guest = (await request(reader, 'guest', 'auth', { scheme: 'guest' })).frame.result.you;
		// Creating: `joined` with the creator as the only member, whose head is
		// already the creator's logged membership, then that membership, then
		// the result; on every connection of the user.
		const created = await request(tab, 'thread', 'room_set', { parent_room_id: 'general', title: 'Kept' });
		threadId = created.frame.result.room_id;
		expect(methods(created.skipped)).toEqual(['room_update', 'membership']);
		const [update, joinedRecord] = created.skipped;
		expect(update.params.joined[0]).toMatchObject({ room_id: threadId, log_id: threadId, members: [{ user_id: userId }] });
		expect(update.params.users).toEqual([{ user_id: userId, name }]);
		expect(joinedRecord).toEqual(membership(threadId, true));
		expect(update.params.joined[0].latest_log_id).toBe(joinedRecord.params.log_id);
		expect(BigInt(joinedRecord.params.log_id)).toBeGreaterThan(BigInt(threadId));
		const otherCreated = await until(other, (frame) => frame.method === 'membership');
		expect(methods(otherCreated.skipped).filter((method) => method === 'room_update')).toHaveLength(1);
		// The parent's other members get the new thread, but not its membership.
		const announced = await until(reader, (frame) => frame.method === 'room_update');
		expect(announced.frame.params.updated[0].room_id).toBe(threadId);

		// A guest's join is not logged: `joined` alone, with every member.
		const guestJoin = await request(reader, 'guest-join', 'room_join', { room_id: threadId });
		expect(methods(guestJoin.skipped)).toEqual(['room_update']);
		expect(guestJoin.skipped[0].params.joined[0].members.map((member: { user_id: string }) => member.user_id)).toEqual([guest.user_id, userId].sort());
		expect(guestJoin.skipped[0].params.users).toEqual([guest, { user_id: userId, name }].sort((a, b) => a.user_id < b.user_id ? -1 : 1));

		// Leaving: the membership reaches the room's members before the change,
		// the leaver's connections included, then `left`, then the result.
		const left = await request(tab, 'leave', 'room_leave', { room_id: threadId });
		expect(left.skipped).toEqual([membership(threadId, false), { method: 'room_update', params: { left: [{ room_id: threadId }] } }]);
		const otherLeft = await until(other, (frame) => frame.method === 'room_update' && frame.params.left !== undefined);
		expect(otherLeft.skipped).toEqual([membership(threadId, false)]);
		expect((await until(reader, (frame) => frame.method === 'membership')).frame).toEqual(membership(threadId, false));
		// Joining again: the membership reaches the members after the change.
		const rejoined = await request(other, 'join', 'room_join', { room_id: threadId });
		expect(methods(rejoined.skipped)).toEqual(['membership', 'room_update']);
		expect(rejoined.skipped[0]).toEqual(membership(threadId, true));
		expect(rejoined.skipped[1].params.joined[0].latest_log_id).toBe(rejoined.skipped[0].params.log_id);
		expect(methods((await until(tab, (frame) => frame.method === 'room_update')).skipped)).toEqual(['membership']);
		expect((await until(reader, (frame) => frame.method === 'membership')).frame).toEqual(membership(threadId, true));

		// History holds the logged memberships, and records keep the user
		// objects they were logged with: no `users`.
		const page = (await request(reader, 'history', 'history', { room_id: threadId })).frame.result;
		expect(page.membership.map((record: { members: Array<{ joined: boolean }> }) => record.members[0].joined)).toEqual([true, false, true]);
		expect(page.membership[0]).toEqual(joinedRecord.params);
		expect(page.messages).toBeUndefined();
		expect(page.last_log_id).toBe(rejoined.skipped[0].params.log_id);
		const posted = await request(tab, 'post', 'message', { body: { text: 'before the rename' } });
		await request(tab, 'rename', 'me', { name: 'Renamed later' });
		const general = (await request(reader, 'general', 'history', { after: posted.frame.result.message_id })).frame.result;
		expect(general.messages[0].from).toEqual({ user_id: userId, name });
		expect(general.users).toBeUndefined();
		// Listings carry the current name.
		const listed = (await request(reader, 'members', 'room_list', { room_id: threadId, members: true })).frame.result;
		expect(listed.users).toEqual(expect.arrayContaining([{ user_id: userId, name: 'Renamed later' }]));
	} finally { tab.close(); other.close(); reader.close(); }

	// A later connection has the same rooms, until the user leaves general;
	// an offline registered member is still listed as a member.
	const later = await resume();
	try {
		expect((await joinedIds(later)).sort()).toEqual(['general', threadId!].sort());
		await request(later, 'leave-general', 'room_leave', { room_id: 'general' });
	} finally { later.close(); }
	const watcher = await connect();
	try {
		await watcher.next();
		await request(watcher, 'guest', 'auth', { scheme: 'guest' });
		const listed = (await request(watcher, 'members', 'room_list', { room_id: threadId!, members: true })).frame.result;
		expect(listed.not_joined[0].members).toEqual([{ user_id: userId }]);
	} finally { watcher.close(); }
	const last = await resume();
	try {
		expect(await joinedIds(last)).toEqual([threadId!]);
	} finally { last.close(); }
});

it('sends a rename only to users who share a room with the renamed user', async () => {
	await registerIdentity('user_session_scope', 'session-scope-ip');
	const token = await issueSession('user_session_scope', 'http://localhost:5173');
	const until = async (peer: Awaited<ReturnType<typeof connect>>, match: (frame: Frame) => boolean): Promise<{ frame: Frame; skipped: Frame[] }> => {
		const skipped: Frame[] = [];
		for (;;) {
			const frame = await peer.next();
			if (match(frame)) return { frame, skipped };
			skipped.push(frame);
		}
	};
	const request = async (peer: Awaited<ReturnType<typeof connect>>, id: string, method: string, params: unknown) => {
		peer.send({ id, method, params });
		return until(peer, (frame) => frame.id === id);
	};
	const tab = await connect();
	const sharing = await connect();
	const apart = await connect();
	try {
		for (const peer of [tab, sharing, apart]) await peer.next();
		await request(tab, 'resume', 'auth', { scheme: 'token', token });
		await request(sharing, 'guest', 'auth', { scheme: 'guest' });
		await request(apart, 'guest', 'auth', { scheme: 'guest' });
		await request(apart, 'leave', 'room_leave', { room_id: 'general' });
		await request(tab, 'rename', 'me', { name: 'Scoped' });
		expect((await until(sharing, (frame) => frame.method === 'user')).frame.params).toEqual({ new: { user_id: 'user_session_scope', name: 'Scoped' } });
		// Apart shares no room: a round trip shows no `user` came before it.
		expect((await request(apart, 'sync', 'me', {})).skipped.filter((frame) => frame.method === 'user')).toEqual([]);
	} finally { tab.close(); sharing.close(); apart.close(); }
});
