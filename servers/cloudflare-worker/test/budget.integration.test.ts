import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { Store, StoreError } from '../src/store';

it('persists an accounting stop when a durable budget reservation fails', async () => {
	const stub = env.DEMO.getByName('budget-reservation-failure');
	const now = Date.now() + 1_000;
	await runInDurableObject(stub, (_instance, state) => {
		const store = new Store(state, {}, { now: () => now });
		store.initialize();
		const before = state.storage.sql.exec<{ reads_reserved: number; writes_reserved: number }>(
			'SELECT reads_reserved, writes_reserved FROM resource_budgets ORDER BY day DESC LIMIT 1',
		).one();
		state.storage.sql.exec(`CREATE TRIGGER fail_budget_reservation
			BEFORE UPDATE OF reads_reserved ON resource_budgets
			BEGIN SELECT RAISE(ABORT, 'injected budget reservation failure'); END`);

		// The failed UPDATE cannot grant a lease. The marker itself is written
		// outside that failed SQL statement so this object cannot retry with an
		// uncharged cache entry.
		expect(() => store.getRoomState()).toThrow('injected budget reservation failure');
		const marker = state.storage.sql.exec<{ value: string }>(
			"SELECT value FROM _meta WHERE key = 'accounting_unsafe' LIMIT 1",
		).one();
		expect(marker.value).toBe('1');
		const after = state.storage.sql.exec<{ reads_reserved: number; writes_reserved: number }>(
			'SELECT reads_reserved, writes_reserved FROM resource_budgets ORDER BY day DESC LIMIT 1',
		).one();
		expect(after).toEqual(before);

		state.storage.sql.exec('DROP TRIGGER fail_budget_reservation');
		expect(() => store.getRoomState()).toThrow(StoreError);
		return store.accountingStatus();
	});

	await evictDurableObject(stub);
	await runInDurableObject(stub, (_instance, state) => {
		const restarted = new Store(state, {}, { now: () => now });
		restarted.initialize();
		expect(restarted.accountingStatus().unsafe).toBe(true);
		const before = restarted.storageAccounting();
		expect(() => restarted.getRoomState()).toThrow('storage accounting is unsafe');
		// A persisted stop is checked before reserveCost performs any SQL, so a
		// restart cannot reissue the failed lease.
		expect(restarted.storageAccounting()).toEqual(before);
	});
});

it('persists an overrun stop across object eviction', async () => {
	const stub = env.DEMO.getByName('budget-overrun-restart');
	const now = Date.now() + 2_000;
	await runInDurableObject(stub, (_instance, state) => {
		const store = new Store(state, {}, { now: () => now });
		store.initialize();
		state.storage.transactionSync(() => {
			for (let index = 1; index <= 100; index += 1) {
				state.storage.sql.exec(
					`INSERT INTO rooms (room_id, parent_room_id, created_log_id, record_log_id, latest_log_id, intro_message_id, fields_json, created_ms, updated_ms)
					 VALUES (?, 'general', ?, ?, ?, NULL, ?, ?, ?)`,
					`budget-thread-${index}`, index, index, index, JSON.stringify({ title: `Thread ${index}` }), now, now,
				);
			}
		});

		// The outer boundary deliberately reserves no operation rows while the
		// nested room read is bounded but larger than that reservation. The guard
		// latches unsafe and persists the marker before returning the error.
		expect(() => store.withMeter('foreground', { reads: 0, writes: 0 }, () => store.listRooms(now), now))
			.toThrow('storage cost exceeded its reservation');
		expect(store.accountingStatus().unsafe).toBe(true);
	});

	await evictDurableObject(stub);
	await runInDurableObject(stub, (_instance, state) => {
		const restarted = new Store(state, {}, { now: () => now });
		restarted.initialize();
		expect(restarted.accountingStatus().unsafe).toBe(true);
	});
});
