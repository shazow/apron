import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { RETENTION_MS, Store, StoreError, type StoreMutationInput } from "../src/store";

const DAY_MS = 86_400_000;

type TestClock = {
	value: number;
	readonly clock: { now(): number };
};

function makeClock(): TestClock {
	const clock: TestClock = {
		value: Date.now() + 1_000,
		clock: { now: () => clock.value },
	};
	return clock;
}

async function withStore<T>(
	name: string,
	config: ConstructorParameters<typeof Store>[1] = {},
	fn: (store: Store, clock: TestClock, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
	const stub = env.DEMO.getByName(`maintenance-${name}-${crypto.randomUUID()}`);
	return runInDurableObject(stub, async (_instance, state) => {
		const clock = makeClock();
		const store = new Store(state, config, clock.clock);
		store.initialize();
		return fn(store, clock, state);
	});
}

function messageInput(clock: TestClock, requestId: string, text: string): StoreMutationInput {
	return {
		userId: "maintenance-user",
		tier: "anonymous",
		ipKey: "maintenance-ip",
		requestId,
		method: "message",
		roomId: "general",
		now: clock.value,
		params: { room_id: "general", body: { format: "plain", text } },
		identity: { user_id: "maintenance-user", name: "Maintenance Tester" },
	};
}

function oneLog(result: ReturnType<Store["mutate"]>): bigint {
	const value = result.transition?.log_id;
	if (value === undefined) throw new Error("mutation did not produce a transition");
	return BigInt(value);
}

function nextUtcDay(value: number): number {
	return (Math.floor(value / DAY_MS) + 1) * DAY_MS;
}

function rowValue<T extends Record<string, unknown>>(state: DurableObjectState, query: string, ...bindings: unknown[]): T {
	const rows = state.storage.sql.exec(query, ...bindings).toArray?.() as unknown as T[] | undefined ?? [];
	if (!rows.length) throw new Error("expected native SQL row");
	return rows[0];
}

it("keeps an early authentication alarm cheap while cleanup is not due", async () => {
	await withStore("early-auth-alarm", {}, async (store, clock, state) => {
		const authDeadline = clock.value + 60_000;
		await store.scheduleAlarm(authDeadline, clock.value);
		expect(await state.storage.getAlarm()).toBe(authDeadline);

		const before = store.storageAccounting();
		const result = store.runCleanup(authDeadline);
		const after = store.storageAccounting();
		expect(result.did_work).toBe(false);
		expect(result.next_due_ms).toBeGreaterThan(authDeadline);
		// The early gate reads the maintenance/room rows and reserves its
		// control work; it must not reserve or execute a full 1024-row batch.
		expect(after.reservedReads - before.reservedReads).toBeLessThan(1_024);
		expect(after.reservedWrites - before.reservedWrites).toBeLessThan(1_024);
		expect(after.writes - before.writes).toBeLessThan(100);
		expect(await state.storage.getAlarm()).toBe(authDeadline);
	});
});

it("defers exhausted cleanup to the next UTC day and schedules one reset alarm", async () => {
	await withStore("maintenance-deferral", {
		maintenanceReadsPerDay: 1_100,
		maintenanceWritesPerDay: 1_100,
	}, async (initial, clock, state) => {
		const day = new Date(clock.value).toISOString().slice(0, 10);
		const sql = state.storage.sql;
		// Leave only the control reserve available. Reconstructing Store makes
		// the native wake path load this durable budget rather than a stale cache.
		sql.exec(
			"UPDATE resource_budgets SET reads_reserved = 1_080, writes_reserved = 1_080, maintenance_reads = 1_080, maintenance_writes = 1_080 WHERE day = ?",
			day,
		);
		sql.exec("UPDATE maintenance SET next_cleanup_ms = ?, cleanup_cutoff_ms = NULL, cleanup_cursor = NULL WHERE id = 1", clock.value);
		const store = new Store(state, {
			maintenanceReadsPerDay: 1_100,
			maintenanceWritesPerDay: 1_100,
		}, clock.clock);
		store.initialize();
		const resetAt = nextUtcDay(clock.value);

		let failure: unknown;
		try {
			store.runCleanup(clock.value);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(StoreError);
		expect((failure as StoreError).code).toBe("retry_after");
		const maintenance = rowValue<{ next_cleanup_ms: number }>(state, "SELECT next_cleanup_ms FROM maintenance WHERE id = 1");
		expect(maintenance.next_cleanup_ms).toBe(resetAt);
		expect(store.budget(clock.value).maintenance_reads).toBe(1_082);
		expect(store.budget(clock.value).maintenance_writes).toBe(1_082);

		await store.scheduleAlarm(undefined, clock.value);
		expect(await state.storage.getAlarm()).toBe(resetAt);
		// Ordinary scheduling no longer fits in the tiny budget, so it uses its
		// six-row control reservation exactly once and does not spin at +1s.
		expect(store.budget(clock.value).maintenance_reads).toBe(1_088);
		expect(store.budget(clock.value).maintenance_writes).toBe(1_088);
		await store.scheduleAlarm(undefined, clock.value);
		expect(await state.storage.getAlarm()).toBe(resetAt);
		void initial;
	});
});

it("makes repeated cleanup invocations idempotent across due alarms and wakes", async () => {
	await withStore("cleanup-idempotence", { cleanupBatch: 1 }, async (store, clock, state) => {
		const firstLog = oneLog(store.mutate(messageInput(clock, "idempotent-1", "first")));
		const secondLog = oneLog(store.mutate(messageInput(clock, "idempotent-2", "second")));
		clock.value += RETENTION_MS + 1;

		const first = store.runCleanup(clock.value);
		expect(first.history_floor).toBe(String(firstLog + 1n));
		expect(first.deleted_transitions).toBe(1);
		const replay = store.runCleanup(clock.value);
		expect(replay.deleted_transitions).toBe(0);
		expect(replay.deleted_messages).toBe(0);
		expect(replay.history_floor).toBe(first.history_floor);
		expect(replay.latest_id).toBe(String(secondLog));
		expect(replay.did_work).toBe(false);

		clock.value = first.next_due_ms + 1;
		const continuation = store.runCleanup(clock.value);
		expect(continuation.deleted_transitions).toBe(1);
		expect(continuation.history_floor).toBe(String(secondLog + 1n));
		const finalReplay = store.runCleanup(clock.value);
		expect(finalReplay.deleted_transitions).toBe(0);
		expect(finalReplay.history_floor).toBe(continuation.history_floor);
		expect(finalReplay.latest_id).toBe(String(secondLog));
		expect(finalReplay.did_work).toBe(false);
		expect(await state.storage.getAlarm()).toBeNull();
	});
});

it("publishes a floor before a failed physical delete and resumes after restart", async () => {
	await withStore("cleanup-restart", { cleanupBatch: 1 }, (store, clock, state) => {
		const oldLog = oneLog(store.mutate(messageInput(clock, "restart-old", "old message")));
		const head = store.getRoomState().latest_id;
		clock.value += RETENTION_MS + 1;
		state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = ? WHERE id = 1", clock.value);
		state.storage.sql.exec(`
			CREATE TRIGGER fail_transition_delete
			BEFORE DELETE ON transitions
			BEGIN
				SELECT RAISE(ABORT, 'injected cleanup deletion failure');
			END
		`);

		let failure: unknown;
		try {
			store.runCleanup(clock.value);
		} catch (error) {
			failure = error;
		}
		const floor = oldLog + 1n;
		expect(failure).toBeDefined();
		expect(store.getRoomState().history_floor).toBe(String(floor));
		expect(store.getRoomState().latest_id).toBe(head);
		expect(Number(rowValue<{ count: number }>(state, "SELECT COUNT(*) AS count FROM transitions").count)).toBe(1);
		expect(Number(rowValue<{ count: number }>(state, "SELECT COUNT(*) AS count FROM messages").count)).toBe(1);
		const hidden = store.history({ roomId: "general", after: 0n, limit: 50, now: clock.value });
		expect(hidden.entries).toEqual([]);
		expect(hidden.history_floor).toBe(String(floor));

		state.storage.sql.exec("DROP TRIGGER fail_transition_delete");
		const restarted = new Store(state, { cleanupBatch: 1 }, clock.clock);
		restarted.initialize();
		let last: ReturnType<Store["runCleanup"]> | undefined;
		for (let run = 0; run < 5; run += 1) {
			clock.value = run === 0 ? clock.value + 1_001 : last!.next_due_ms + 1;
			last = restarted.runCleanup(clock.value);
			if (!last.did_work && last.next_due_ms > clock.value) break;
		}
		expect(last?.history_floor).toBe(String(floor));
		expect(last?.latest_id).toBe(head);
		expect(Number(rowValue<{ count: number }>(state, "SELECT COUNT(*) AS count FROM transitions").count)).toBe(0);
		expect(Number(rowValue<{ count: number }>(state, "SELECT COUNT(*) AS count FROM messages").count)).toBe(0);
		expect(restarted.history({ roomId: "general", after: 0n, limit: 50, now: clock.value }).entries).toEqual([]);
	});
});
