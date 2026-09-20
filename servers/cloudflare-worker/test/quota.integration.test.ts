import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { Store, StoreError } from '../src/store';

const DAY = 86_400_000;

it('shares an anonymous rolling window across identities and calendar-minute boundaries', async () => {
	await runInDurableObject(env.DEMO.getByName('quota-rolling-minute'), (_instance, state) => {
		let now = (Math.floor(Date.now() / DAY) + 1) * DAY + 119_000;
		const store = new Store(state, {}, { now: () => now });
		const post = (userId: string) => store.mutate({ userId, ipKey: 'shared-nat', method: 'message', now,
			identity: { user_id: userId }, params: { body: { text: 'bounded' } } });
		for (let index = 0; index < 5; index++) post(`guest-${index}`);
		now += 1_001;
		try { post('fresh-guest'); expect.unreachable(); }
		catch (error) { expect(error).toBeInstanceOf(StoreError); expect((error as StoreError).retryAfterMs).toBe(58_999); }
		now += 59_000;
		expect(post('fresh-guest').result.message_id).toBeTruthy();
	});
});

it('uses durable registered identities for twenty posts while preserving the aggregate IP cap', async () => {
	await runInDurableObject(env.DEMO.getByName('quota-registered-ip'), (_instance, state) => {
		const now = (Math.floor(Date.now() / DAY) + 1) * DAY + 43_200_000;
		const store = new Store(state, {}, { now: () => now });
		// Identity fixtures exercise policy only; signed ceremonies are tested in
		// auth.integration.test.ts and the browser against the real verifier.
		for (const userId of ['registered-a', 'registered-b']) store.registerIdentity({
			userId, name: userId, userHandle: userId, ipKey: 'shared-nat', now,
			credential: { credentialId: userId, userId, publicKey: 'fixture-policy-only', counter: 0 },
		});
		const post = (userId: string) => store.mutate({ userId, ipKey: 'shared-nat', method: 'message', now,
			identity: { user_id: userId }, params: { body: { text: 'bounded' } } });
		for (let index = 0; index < 20; index++) post('registered-a');
		expect(() => post('registered-a')).toThrow('Posting limit reached');
		for (let index = 0; index < 10; index++) post('registered-b');
		expect(() => post('registered-b')).toThrow('Posting limit reached');
	});
});

it('returns the longest applicable retry window and never replenishes on a backward clock', async () => {
	await runInDurableObject(env.DEMO.getByName('quota-retry-reset'), (_instance, state) => {
		let now = (Math.floor(Date.now() / DAY) + 1) * DAY + 43_200_000;
		const store = new Store(state, { anonymousPostsPerMinute: 1, anonymousPostsPerDay: 1 }, { now: () => now });
		const post = () => store.mutate({ userId: 'guest', ipKey: 'nat', method: 'message', now,
			identity: { user_id: 'guest' }, params: { body: { text: 'bounded' } } });
		post();
		now -= 60_000;
		try { post(); expect.unreachable(); }
		catch (error) { expect(error).toBeInstanceOf(StoreError); expect((error as StoreError).retryAfterMs).toBe(43_200_000); }
		now += 43_260_001;
		expect(post().result.message_id).toBeTruthy();
	});
});
