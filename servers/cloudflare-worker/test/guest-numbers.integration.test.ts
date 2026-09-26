import { SELF, env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/budget';
import { Store } from '../src/store';

type Frame = { id?: string | null; method?: string; result?: any; error?: any; params?: any };
type Runtime = {
	store: Store;
	nextGuestNumber(): number;
};

const BLOCK = DEFAULT_LIMITS.guestNumberBlock;
let nextNet = 1;

/** A socket to the public object from its own IPv6 /64, so per-IP limits never meet. */
async function connect() {
	const response = await SELF.fetch('https://demo.test/ws', { headers: {
		Upgrade: 'websocket', Origin: 'http://localhost:5173', 'CF-Connecting-IP': `2001:db8:${(0x4700 + nextNet++).toString(16)}::1`,
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
	const peer = {
		send(frame: unknown) { socket.send(JSON.stringify(frame)); },
		next(): Promise<Frame> {
			const frame = frames.shift();
			return frame ? Promise.resolve(frame) : new Promise(resolve => waiters.push(resolve));
		},
		close() { socket.close(1000, 'test complete'); },
	};
	expect((await peer.next()).method).toBe('server');
	return peer;
}

/** Guest auth on a fresh socket; the result's `you`. */
async function guest(params: Record<string, unknown> = {}): Promise<{ user_id: string; name?: string; close(): void }> {
	const peer = await connect();
	peer.send({ method: 'auth', id: 'auth', params: { scheme: 'guest', ...params } });
	const reply = await peer.next();
	expect(reply.id).toBe('auth');
	return { ...reply.result.you, close: () => peer.close() };
}

function numberOf(userId: string): number {
	const match = /^guest_([1-9]\d*)$/.exec(userId);
	expect(match, `${userId} is not guest_<n>`).not.toBeNull();
	return Number(match![1]);
}

function storedMark(state: DurableObjectState): number {
	const rows = state.storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'guest_number_mark'").toArray();
	return rows.length ? Number(rows[0].value) : 0;
}

describe('guest numbers', () => {
	it('assigns consecutive guest_<n> IDs and names, ignoring requested ones', async () => {
		const first = await guest({ user_id: 'guest_1', name: 'Mallory' });
		const second = await guest({ user_id: 'ada' });
		const third = await guest();
		const n = numberOf(first.user_id);
		expect([first, second, third].map(you => [you.user_id, you.name])).toEqual([
			[`guest_${n}`, `Guest ${n}`],
			[`guest_${n + 1}`, `Guest ${n + 1}`],
			[`guest_${n + 2}`, `Guest ${n + 2}`],
		]);
		// Every number handed out was durably reserved first.
		const mark = await runInDurableObject(env.DEMO.getByName('public-demo-v1'), (_instance, state) => storedMark(state));
		expect(mark).toBeGreaterThanOrEqual(n + 2);
		for (const you of [first, second, third]) you.close();
	});

	it('gives concurrent auths distinct numbers across a block boundary', async () => {
		const peers = await Promise.all(Array.from({ length: BLOCK + 3 }, () => connect()));
		for (const peer of peers) peer.send({ method: 'auth', id: 'auth', params: { scheme: 'guest' } });
		const replies = await Promise.all(peers.map(peer => peer.next()));
		const numbers = replies.map(reply => numberOf(reply.result.you.user_id));
		expect(new Set(numbers).size).toBe(peers.length);
		// No wake happened in between, so the numbers are one unbroken run.
		const sorted = [...numbers].sort((a, b) => a - b);
		expect(sorted.at(-1)! - sorted[0]).toBe(peers.length - 1);
		for (const peer of peers) peer.close();
	});

	it('serves a block from memory with one durable write, and reserves a fresh block after a restart', async () => {
		const stub = env.DEMO.getByName(`guest-numbers-${crypto.randomUUID()}`);
		const firstRun = await runInDurableObject(stub, (instance, state) => {
			const runtime = instance as unknown as Runtime;
			const reserve = runtime.store.reserveGuestNumbers.bind(runtime.store);
			let reservations = 0;
			runtime.store.reserveGuestNumbers = (count, now) => { reservations += 1; return reserve(count, now); };
			const before = runtime.store.storageAccounting();
			const first = runtime.nextGuestNumber();
			const afterReservation = runtime.store.storageAccounting();
			const rest = Array.from({ length: BLOCK - 1 }, () => runtime.nextGuestNumber());
			const afterBlock = runtime.store.storageAccounting();
			const next = runtime.nextGuestNumber();
			const afterNext = runtime.store.storageAccounting();
			return {
				numbers: [first, ...rest, next],
				reservations,
				mark: storedMark(state),
				reservationReads: afterReservation.reads - before.reads,
				reservedReads: afterReservation.reservedReads - before.reservedReads,
				reservationWrites: afterReservation.writes - before.writes,
				reservedWrites: afterReservation.reservedWrites - before.reservedWrites,
				blockWrites: afterBlock.writes - afterReservation.writes,
				nextWrites: afterNext.writes - afterBlock.writes,
			};
		});
		console.info('guest-number-block', JSON.stringify(firstRun));
		// 1..BLOCK from the first block, then BLOCK + 1 opens the second.
		expect(firstRun.numbers).toEqual(Array.from({ length: BLOCK + 1 }, (_, index) => index + 1));
		expect(firstRun.reservations).toBe(2);
		expect(firstRun.mark).toBe(2 * BLOCK);
		// A reservation writes the mark and its own budget bookkeeping, within
		// what it reserved; the numbers served from memory write nothing.
		expect(firstRun.reservationWrites).toBeGreaterThan(0);
		expect(firstRun.reservationWrites).toBeLessThanOrEqual(firstRun.reservedWrites);
		expect(firstRun.blockWrites).toBe(0);
		expect(firstRun.nextWrites).toBeGreaterThan(0);
		expect(firstRun.nextWrites).toBeLessThanOrEqual(firstRun.reservationWrites);

		// The restarted object cannot see how far the second block got, so it
		// starts past it: BLOCK + 2 .. 2 * BLOCK are skipped, never reissued.
		await evictDurableObject(stub);
		const secondRun = await runInDurableObject(stub, (instance, state) => {
			const runtime = instance as unknown as Runtime;
			return { numbers: [runtime.nextGuestNumber(), runtime.nextGuestNumber()], mark: storedMark(state) };
		});
		expect(secondRun.numbers).toEqual([2 * BLOCK + 1, 2 * BLOCK + 2]);
		expect(secondRun.mark).toBe(3 * BLOCK);
	});

	it('reserves blocks from the stored mark in any Store instance, and keeps the mark across a schema reset', async () => {
		const stub = env.DEMO.getByName(`guest-number-store-${crypto.randomUUID()}`);
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const store = new Store(state, {});
			store.initialize();
			const first = store.reserveGuestNumbers(5);
			const second = store.reserveGuestNumbers(3);
			const restarted = new Store(state, {});
			restarted.initialize();
			const third = restarted.reserveGuestNumbers(5);
			let invalid: unknown;
			try { restarted.reserveGuestNumbers(0); } catch (error) { invalid = error; }
			await restarted.resetStorage();
			const afterReset = restarted.reserveGuestNumbers(5);
			return { first, second, third, invalid: (invalid as { code?: string })?.code, afterReset };
		});
		expect(result.first).toEqual({ first: 1, limit: 6 });
		expect(result.second).toEqual({ first: 6, limit: 9 });
		expect(result.third).toEqual({ first: 9, limit: 14 });
		expect(result.invalid).toBe('invalid_params');
		expect(result.afterReset).toEqual({ first: 14, limit: 19 });
	});
});
