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
async function registerIdentity(userId: string): Promise<void> {
	await runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as { store: { registerIdentity(input: Record<string, unknown>): unknown } };
		runtime.store.registerIdentity({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: 'session-test-ip',
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
	});
}

async function issueSession(userId: string, origin: string): Promise<string> {
	return runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as { issueSession(userId: string, origin: string, now: number): Promise<string> };
		return runtime.issueSession(userId, origin, Date.now());
	});
}

it('advertises token resume only where passkeys are offered', async () => {
	const trusted = await connect();
	expect((await trusted.next()).params.auth).toEqual(['webauthn', 'token', 'guest']);
	trusted.close();
	const untrusted = await connect(null);
	expect((await untrusted.next()).params.auth).toEqual(['guest']);
	untrusted.send({ id: 't', method: 'auth', params: { scheme: 'token', token: 'anything' } });
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
	expect((await peer.next()).method).toBe('room');

	// A registered connection cannot switch identities in place.
	peer.send({ id: 'again', method: 'auth', params: { scheme: 'token', token } });
	expect((await peer.next()).error.code).toBe(-32001);
	peer.close();

	// The resume pushed the expiry out to a full lifetime.
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
	peer.send({ id: 'clear', method: 'me', params: { name: '' } });
	expect((await reply('clear')).result).toEqual({ you: { user_id: 'user_session_me' } });
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
