import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';

type Frame = { id?: string | null; method?: string; result?: any; error?: any; params?: any };
let nextIp = 40;

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
	expect((await trusted.next()).params.auth).toEqual(['webauthn', 'token', 'anonymous']);
	trusted.close();
	const untrusted = await connect(null);
	expect((await untrusted.next()).params.auth).toEqual(['anonymous']);
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
			if (session.userId === 'user_session_two') await state.storage.put(key, { ...session, expiresMs: Date.now() - 1 });
		}
		await (instance as unknown as { sweepSessions(now: number): Promise<void> }).sweepSessions(Date.now());
		const remaining = await state.storage.list<{ userId: string }>({ prefix: 'session:' });
		expect([...remaining.values()].some((session) => session.userId === 'user_session_two')).toBe(false);
	});
});
