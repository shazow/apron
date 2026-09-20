import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { Store } from '../src/store';

it('rolls back failed writes atomically while keeping their resource reservation spent', async () => {
	await runInDurableObject(env.DEMO.getByName('transaction-failure-boundary'), (_instance, state) => {
		const now = Date.now() + 1_000;
		const store = new Store(state, {}, { now: () => now });
		const before = store.getRoomState();
		const budgetBefore = store.budget(now);
		// SQLite itself raises after the transition insert, inside transactionSync.
		// This exercises real rollback rather than substituting a fake database.
		state.storage.sql.exec(`CREATE TRIGGER fail_snapshot BEFORE INSERT ON messages
			BEGIN SELECT RAISE(ABORT, 'injected snapshot failure'); END`);
		const input = {
			userId: 'guest-failure', ipKey: 'failure-ip', method: 'message', now,
			requestId: 'retry-after-failed-commit', identity: { user_id: 'guest-failure' },
			params: { room_id: 'general', body: { text: 'atomic message' } },
		};
		expect(() => store.mutate(input)).toThrow('injected snapshot failure');
		expect(store.getRoomState().latest_log_id).toBe(before.latest_log_id);
		for (const table of ['transitions', 'messages', 'accepted_requests', 'principal_limits']) {
			expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n).toBe(0);
		}
		expect(store.budget(now).writes).toBeGreaterThan(budgetBefore.writes);
		state.storage.sql.exec('DROP TRIGGER fail_snapshot');
		const committed = store.mutate(input);
		expect(committed.transition?.message.body?.text).toBe('atomic message');
		// Discard the first result and reconstruct the store as after a lost reply.
		const restarted = new Store(state, {}, { now: () => now });
		const replay = restarted.mutate(input);
		expect(replay.deduplicated).toBe(true);
		expect(replay.result).toEqual(committed.result);
		expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM transitions').one().n).toBe(1);
	});
});
