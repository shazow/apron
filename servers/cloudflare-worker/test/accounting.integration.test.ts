import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Store, StoreError, defaultStoreConfig, type StoreConfig } from '../src/store';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

class FakeClock {
	private value: number;

	constructor(value: number) {
		this.value = value;
	}

	now(): number {
		return this.value;
	}

	set(value: number): void {
		this.value = value;
	}
}

function futureUtcNoon(): number {
	// The DO constructor has already recorded the real clock.  Start the fake
	// clock two UTC days ahead so the monotonic effective clock never moves
	// backwards, even when a test starts late in the current day.
	return (Math.floor(Date.now() / DAY) + 2) * DAY + 12 * HOUR;
}

function accountingConfig(overrides: Partial<StoreConfig> = {}): StoreConfig {
	return defaultStoreConfig(overrides);
}

function messageInput(
	clock: FakeClock,
	userId: string,
	text: string,
	requestId?: string,
	messageId?: string,
	extensions: Record<string, unknown> = {},
) {
	return {
		userId,
		ipKey: 'audit-ip',
		...(requestId ? { requestId } : {}),
		method: 'message' as const,
		now: clock.now(),
		params: {
			room_id: 'general',
			...extensions,
			...(messageId ? { message_id: messageId } : {}),
			body: { text, format: 'plain' },
		},
		identity: { user_id: userId, name: 'Accounting audit' },
	};
}

function diffAccounting(after: ReturnType<Store['storageAccounting']>, before: ReturnType<Store['storageAccounting']>) {
	return {
		reads: after.reads - before.reads,
		writes: after.writes - before.writes,
		operations: after.operations - before.operations,
	};
}

function diffBudget(after: ReturnType<Store['budget']>, before: ReturnType<Store['budget']>) {
	return {
		reads: after.reads - before.reads,
		writes: after.writes - before.writes,
		foregroundReads: after.foreground_reads - before.foreground_reads,
		foregroundWrites: after.foreground_writes - before.foreground_writes,
		maintenanceReads: after.maintenance_reads - before.maintenance_reads,
		maintenanceWrites: after.maintenance_writes - before.maintenance_writes,
		posts: after.posts - before.posts,
	};
}

function expectRetry(error: unknown): asserts error is StoreError {
	expect(error).toBeInstanceOf(StoreError);
	expect((error as StoreError).code).toBe('retry_after');
}

function explain(sql: any, query: string, ...bindings: unknown[]) {
	const cursor = sql.exec(query, ...bindings) as { toArray(): Array<{ detail: string }> };
	return cursor.toArray().map((row: { detail: string }) => row.detail);
}

describe('measured storage accounting', () => {
	it('measures three UTC days of traffic, retention cleanup, and reserved versus observed work', async () => {
		const stub = env.DEMO.getByName('accounting-three-days-v1');
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, accountingConfig(), clock);
			store.initialize();
			const base = clock.now();
			const operationCosts: Array<Record<string, unknown>> = [];

			const measure = (label: string, callback: () => unknown) => {
				const beforeBudget = store.budget();
				const beforeAccounting = store.storageAccounting();
				const value = callback();
				const afterAccounting = store.storageAccounting();
				const afterBudget = store.budget();
				const observed = diffAccounting(afterAccounting, beforeAccounting);
				const reserved = diffBudget(afterBudget, beforeBudget);
				operationCosts.push({ label, observed, reserved, withinReserve: observed.reads <= reserved.reads && observed.writes <= reserved.writes });
				return value;
			};

			const first = measure('day-0 create', () => store.commitMutation(messageInput(clock, 'audit-user', 'day zero', 'day-0')));
			const firstMessageId = (first as { messageId?: string }).messageId;
			expect(firstMessageId).toBeTruthy();

			clock.set(clock.now() + DAY + 2 * HOUR);
			measure('day-1 create', () => store.commitMutation(messageInput(clock, 'audit-user', 'day one', 'day-1')));

			clock.set(clock.now() + DAY);
			const edit = measure('day-2 edit retained message', () => store.commitMutation(messageInput(clock, 'audit-user', 'edited after original expiry', 'day-2-edit', firstMessageId)));
			measure('day-2 create', () => store.commitMutation(messageInput(clock, 'audit-user', 'day two', 'day-2')));

			clock.set(clock.now() + 11 * HOUR);
			const cleanup = measure('cleanup', () => store.runCleanup(clock.now()));
			const page = measure('history after cleanup', () => store.historyPage({ roomId: 'general', limit: 50, now: clock.now() }));
			const room = store.getRoomState();
			const observed = store.storageAccounting();
			const budget = store.budget();
			const size = store.databaseSize();

			const cleanupResult = cleanup as { history_floor: string; deleted_transitions: number; deleted_messages: number };
			const history = page as { entries: Array<{ log_id: string; message: { message_id: string } }>; latest_log_id: string; history_log_id: string | null };
			expect(cleanupResult.deleted_transitions).toBe(2);
			expect(cleanupResult.deleted_messages).toBe(1);
			expect(history.entries).toHaveLength(2);
			expect(history.entries.some((entry) => entry.message.message_id === firstMessageId)).toBe(true);
			expect(history.entries.every((entry) => BigInt(entry.log_id) >= BigInt(history.history_log_id!))).toBe(true);
			expect(room.history_log_id).toBe(cleanupResult.history_floor);
			expect(history.latest_log_id).toBe(room.latest_log_id);
			expect(BigInt(room.latest_log_id)).toBeGreaterThanOrEqual(BigInt(room.history_log_id!));

			return {
				base,
				cleanup: cleanupResult,
				history: { floor: history.history_log_id, entries: history.entries.map((entry) => ({ log_id: entry.log_id, message_id: entry.message.message_id })) },
				operationCosts,
				budget,
				observed,
				databaseSize: size,
			};
		});
		console.info('accounting-three-days', JSON.stringify(result));
		for (const operation of result.operationCosts as Array<{ label: string; withinReserve: boolean }>) {
			expect(operation.withinReserve, `${operation.label} exceeded its reserved rows`).toBe(true);
		}
	});

	it('charges rejected quota work and stops repeated denial before more SQL work', async () => {
		const stub = env.DEMO.getByName('accounting-rejections-v1');
		const config = accountingConfig({
			anonymousPostsPerMinute: 1,
			anonymousPostsPerDay: 100,
			ipPostsPerMinute: 1,
			ipPostsPerDay: 100,
			globalPostsPerMinute: 100,
			globalPostsPerDay: 100,
			// Deliberately small explicit exhaustion ceiling. The test drains the
			// bounded request-ID lookup allowance instead of assuming a fixed
			// mutation reservation amount.
			foregroundReadsPerDay: 1_000,
			foregroundWritesPerDay: 1_000,
		});
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, config, clock);
			store.initialize();
			const accepted = store.commitMutation(messageInput(clock, 'reject-user', 'accepted', 'accepted'));
			const afterAcceptedAccounting = store.storageAccounting();
			const afterAcceptedBudget = store.budget();

			let quotaError: unknown;
			try {
				store.commitMutation(messageInput(clock, 'reject-user', 'rejected by post quota', 'rejected'));
			} catch (error) {
				quotaError = error;
			}
			expectRetry(quotaError);
			const afterRejectedAccounting = store.storageAccounting();
			const afterRejectedBudget = store.budget();
			const rejectedObserved = diffAccounting(afterRejectedAccounting, afterAcceptedAccounting);
			const rejectedReserved = diffBudget(afterRejectedBudget, afterAcceptedBudget);
			// Depending on which bounded admission check rejects the request, the
			// request may have paid either the duplicate lookup or the full
			// mutation reservation. In both cases the charged work stays bounded.
			expect(rejectedReserved.posts).toBeLessThanOrEqual(1);
			expect(rejectedObserved.reads).toBeGreaterThan(0);
			expect(rejectedObserved.writes).toBeGreaterThan(0);
			expect(rejectedObserved.reads).toBeLessThanOrEqual(rejectedReserved.reads);
			expect(rejectedObserved.writes).toBeLessThanOrEqual(rejectedReserved.writes);

			let previousCapacityAccounting = store.storageAccounting();
			let reachedStableDenial = false;
			for (let attempt = 0; attempt < 16; attempt += 1) {
				let capacityError: unknown;
				try {
					store.commitMutation(messageInput(clock, 'reject-user', 'capacity stop', `capacity-${attempt}`));
				} catch (error) {
					capacityError = error;
				}
				expectRetry(capacityError);
				const currentAccounting = store.storageAccounting();
				if (currentAccounting.reads === previousCapacityAccounting.reads &&
					currentAccounting.writes === previousCapacityAccounting.writes &&
					currentAccounting.operations === previousCapacityAccounting.operations) {
					reachedStableDenial = true;
					break;
				}
				previousCapacityAccounting = currentAccounting;
			}
			expect(reachedStableDenial).toBe(true);

			const transitions = state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM transitions').one().count;
			return {
				accepted: accepted.result,
				acceptedAccounting: afterAcceptedAccounting,
				rejectedObserved,
				rejectedReserved,
				budget: store.budget(),
				transitionCount: Number(transitions),
			};
		});
		console.info('accounting-rejections', JSON.stringify(result));
		expect(result.transitionCount).toBe(1);
	});

	it('preserves limiter state across object eviction and does not rewrite schema on reinitialization', async () => {
		const stub = env.DEMO.getByName('accounting-persistence-v1');
		const config = accountingConfig({
			anonymousPostsPerMinute: 100,
			anonymousPostsPerDay: 1,
			ipPostsPerMinute: 100,
			ipPostsPerDay: 100,
			globalPostsPerMinute: 100,
			globalPostsPerDay: 100,
		});
		const clockValue = futureUtcNoon();
		const first = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(clockValue);
			const store = new Store(state, config, clock);
			store.initialize();
			store.commitMutation(messageInput(clock, 'persistent-user', 'only daily post', 'persistent'));
			const limits = state.storage.sql.exec('SELECT scope, principal_key, post_events_json, day, posts_day FROM principal_limits').toArray();
			return { size: store.databaseSize(), budget: store.budget(), limits };
		});
		await evictDurableObject(stub);
		const second = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(clockValue);
			const store = new Store(state, config, clock);
			store.initialize();
			const afterInit = store.storageAccounting();
			expect(afterInit.writes).toBe(0);
			let error: unknown;
			try {
				store.commitMutation(messageInput(clock, 'persistent-user', 'must remain limited', 'persistent-retry'));
			} catch (candidate) {
				error = candidate;
			}
			expectRetry(error);
			const limits = state.storage.sql.exec('SELECT scope, principal_key, post_events_json, day, posts_day FROM principal_limits').toArray();
			const transitions = state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM transitions').one().count;
			return { afterInit, budget: store.budget(), size: store.databaseSize(), limits, transitions: Number(transitions) };
		});
		console.info('accounting-persistence', JSON.stringify({ first, second }));
		expect(second.budget.posts).toBe(first.budget.posts + 1);
		expect(second.limits).toEqual(first.limits);
		expect(second.transitions).toBe(1);
		expect(second.size).toBe(first.size);
	});

	it('measures room and thread listing costs at the 100-thread policy ceiling', async () => {
		const stub = env.DEMO.getByName('accounting-room-list-v1');
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, accountingConfig(), clock);
			store.initialize();
			state.storage.transactionSync(() => {
				for (let index = 1; index <= 100; index += 1) {
					state.storage.sql.exec(
						`INSERT INTO threads (room_id, thread_id, title, summary, root_message_id, created_ms, updated_ms)
						 VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
						'general', `t_${index.toString(36)}`, `Thread ${index}`, clock.now(), clock.now(),
					);
				}
			});

			const beforeRoomBudget = store.budget();
			const beforeRoomAccounting = store.storageAccounting();
			const room = store.room();
			const afterRoomAccounting = store.storageAccounting();
			const afterRoomBudget = store.budget();
			const beforeThreadsBudget = store.budget();
			const beforeThreadsAccounting = store.storageAccounting();
			const threads = store.getThreads();
			const afterThreadsAccounting = store.storageAccounting();
			const afterThreadsBudget = store.budget();
			const roomObserved = diffAccounting(afterRoomAccounting, beforeRoomAccounting);
			const roomReserved = diffBudget(afterRoomBudget, beforeRoomBudget);
			const threadsObserved = diffAccounting(afterThreadsAccounting, beforeThreadsAccounting);
			const threadsReserved = diffBudget(afterThreadsBudget, beforeThreadsBudget);
			expect(room.threads).toHaveLength(100);
			expect(threads).toHaveLength(100);
			expect(roomObserved.reads).toBeLessThanOrEqual(roomReserved.reads);
			expect(roomObserved.writes).toBeLessThanOrEqual(roomReserved.writes);
			expect(threadsObserved.reads).toBeLessThanOrEqual(threadsReserved.reads);
			expect(threadsObserved.writes).toBeLessThanOrEqual(threadsReserved.writes);
			return { room: { observed: roomObserved, reserved: roomReserved }, threads: { observed: threadsObserved, reserved: threadsReserved } };
		});
		console.info('accounting-room-list', JSON.stringify(result));
	});

	it('keeps thread history at the 50-entry limit with more than one indexed slice', async () => {
		const stub = env.DEMO.getByName('accounting-thread-history-cardinality-v1');
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, accountingConfig(), clock);
			store.initialize();
			const threadId = 'thread-cardinality';
			// Each indexed membership branch has 60 rows, so the 51-row source
			// slice (limit + one) is exercised independently on both indexes.
			const totalRows = 180;
			state.storage.transactionSync(() => {
				state.storage.sql.exec(
					`INSERT INTO threads (room_id, thread_id, title, summary, root_message_id, created_ms, updated_ms)
					 VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
					'general', threadId, 'Indexed cardinality', clock.now(), clock.now(),
				);
				for (let index = 1; index <= totalRows; index += 1) {
					const messageId = `thread-message-${index}`;
					const snapshot = JSON.stringify({
						message_id: messageId,
						from: { user_id: 'thread-history-user' },
						body: { text: `thread history ${index}`, format: 'plain', embeds: [] },
					});
					state.storage.sql.exec(
						`INSERT INTO transitions
						 (room_id, log_id, commit_ms, message_id, snapshot_json, previous_thread_id, thread_id)
						 VALUES (?, ?, ?, ?, ?, ?, ?)`,
						'general', index, clock.now() + index, messageId, snapshot,
						index % 3 === 0 ? threadId : null,
						index % 3 === 1 || index % 3 === 0 ? threadId : null,
					);
				}
				state.storage.sql.exec('UPDATE room_state SET last_log_id = ?, last_commit_ms = ? WHERE room_id = ?', totalRows, clock.now() + totalRows, 'general');
			});

			const beforeAccounting = store.storageAccounting();
			const beforeBudget = store.budget();
			const page = store.historyPage({ roomId: 'general', threadId, after: '0', limit: 50, now: clock.now() });
			const afterAccounting = store.storageAccounting();
			const afterBudget = store.budget();
			const observed = diffAccounting(afterAccounting, beforeAccounting);
			const reserved = diffBudget(afterBudget, beforeBudget);
			expect(page.entries).toHaveLength(50);
			expect(page.more).toBe(true);
			expect(page.first_id).toBe('1');
			expect(page.last_id).toBe('75');
			expect(observed.reads).toBeLessThanOrEqual(reserved.reads);
			expect(observed.writes).toBeLessThanOrEqual(reserved.writes);
			return { observed, reserved, first: page.first_id, last: page.last_id, more: page.more };
		});
		console.info('accounting-thread-history-cardinality', JSON.stringify(result));
	});

	it('calibrates default costs for maximum snapshots, repeated edits, and a UTC midnight double burst', async () => {
		const stub = env.DEMO.getByName('accounting-default-calibration-v1');
		const config = accountingConfig();
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const midnight = (Math.floor(Date.now() / DAY) + 2) * DAY;
			const clock = new FakeClock(midnight - 20_000);
			const store = new Store(state, config, clock);
			store.initialize();
			const costs: Array<Record<string, unknown>> = [];
			const measure = (label: string, callback: () => unknown) => {
				const beforeBudget = store.budget();
				const beforeAccounting = store.storageAccounting();
				const value = callback();
				const afterAccounting = store.storageAccounting();
				const afterBudget = store.budget();
				const observed = diffAccounting(afterAccounting, beforeAccounting);
				const reserved = diffBudget(afterBudget, beforeBudget);
				costs.push({ label, observed, reserved, withinReserve: observed.reads <= reserved.reads && observed.writes <= reserved.writes });
				return value;
			};
			const measureFailure = (label: string, callback: () => unknown) => {
				const beforeBudget = store.budget();
				const beforeAccounting = store.storageAccounting();
				let error: unknown;
				try { callback(); } catch (candidate) { error = candidate; }
				const afterAccounting = store.storageAccounting();
				const afterBudget = store.budget();
				const observed = diffAccounting(afterAccounting, beforeAccounting);
				const reserved = diffBudget(afterBudget, beforeBudget);
				costs.push({ label, observed, reserved, error: error instanceof StoreError ? error.code : 'none', withinReserve: observed.reads <= reserved.reads && observed.writes <= reserved.writes });
				return error;
			};
			const maximumText = 'x'.repeat(config.maxTextBytes);
			// Preserve a large extension field as part of the snapshot so this
			// calibration reaches the 8 KiB snapshot ceiling instead of measuring
			// only the 4 KiB body-text limit.
			const maximumExtensions = { extension_padding: 'p'.repeat(3_900) };
			const first = measure('maximum snapshot create', () => store.commitMutation(messageInput(clock, 'calibration-user', maximumText, 'maximum-create', undefined, maximumExtensions)));
			const messageId = (first as { messageId?: string }).messageId;
			expect(messageId).toBeTruthy();
			const snapshotBytes = JSON.stringify((first as { message?: unknown }).message).length;
			expect(snapshotBytes).toBeGreaterThan(8_000);
			expect(snapshotBytes).toBeLessThanOrEqual(config.maxSnapshotBytes);

			// Five accepted operations fit the default anonymous minute window. The
			// sixth is intentionally rejected before the UTC rollover.
			for (let index = 0; index < 4; index += 1) {
				clock.set(midnight - 19_000 + index * 1_000);
				measure(`maximum snapshot edit pre-midnight ${index + 1}`, () => store.commitMutation(messageInput(clock, 'calibration-user', maximumText, `maximum-edit-pre-${index}`, messageId, maximumExtensions)));
			}
			clock.set(midnight - 15_000);
			const rejected = measureFailure('sixth pre-midnight post', () => store.commitMutation(messageInput(clock, 'calibration-user', 'must be rejected', 'pre-midnight-rejected')));
			expectRetry(rejected);

			clock.set(midnight + 61_000);
			for (let index = 0; index < 5; index += 1) {
				clock.set(midnight + 61_000 + index * 1_000);
				measure(`post-midnight burst ${index + 1}`, () => store.commitMutation(messageInput(clock, 'calibration-user', maximumText, `maximum-create-post-${index}`, undefined, maximumExtensions)));
			}

			for (let group = 0; group < 2; group += 1) {
				const start = midnight + 130_000 + group * 61_000;
				for (let index = 0; index < 4; index += 1) {
					clock.set(start + index * 1_000);
					measure(`maximum snapshot edit group ${group + 1}.${index + 1}`, () => store.commitMutation(messageInput(clock, 'calibration-user', maximumText, `maximum-edit-${group}-${index}`, messageId, maximumExtensions)));
				}
			}

			const history = store.historyPage({ roomId: 'general', limit: 50, now: clock.now() });
			const limiter = state.storage.sql.exec<{ day: string; posts_day: number }>(
				"SELECT day, posts_day FROM principal_limits WHERE scope = 'post' AND principal_key = ? LIMIT 1",
				'anonymous:audit-ip',
			).one();
			expect(history.entries).toHaveLength(18);
			expect(limiter.posts_day).toBe(13);
			expect(limiter.day).toBe(new Date(clock.now()).toISOString().slice(0, 10));
			for (const operation of costs) {
				expect(operation.withinReserve, `${String(operation.label)} exceeded its reservation`).toBe(true);
			}
			return {
				midnight,
				snapshotBytes,
				acceptedTransitions: history.entries.length,
				postDay: limiter,
				maximumObservedReads: Math.max(...costs.map((operation) => (operation.observed as { reads: number }).reads)),
				maximumObservedWrites: Math.max(...costs.map((operation) => (operation.observed as { writes: number }).writes)),
				costs,
			};
		});
		console.info('accounting-default-calibration', JSON.stringify(result));
	});

	it('keeps the maintenance reserve available after foreground quota exhaustion', async () => {
		const stub = env.DEMO.getByName('accounting-maintenance-reserve-v1');
		// Tiny ceilings are used only for deterministic exhaustion. All row-cost
		// estimates and maintenance ceilings remain the deployment defaults.
		const config = accountingConfig({
			anonymousPostsPerMinute: 1_000,
			anonymousPostsPerDay: 1_000,
			ipPostsPerMinute: 1_000,
			ipPostsPerDay: 1_000,
			globalPostsPerMinute: 1_000,
			globalPostsPerDay: 1_000,
			// The ceiling is intentionally small, but the accepted count is
			// discovered by the real reservation path rather than mirroring a
			// particular mutation-cost constant.
			foregroundReadsPerDay: 1_000,
			foregroundWritesPerDay: 1_000,
		});
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, config, clock);
			store.initialize();
			const foregroundDay = new Date(clock.now()).toISOString().slice(0, 10);
			let acceptedMutations = 0;
			for (let index = 0; index < 16; index += 1) {
				try {
					store.commitMutation(messageInput(clock, 'maintenance-user', `accepted-${index}`, `maintenance-${index}`));
					acceptedMutations += 1;
				} catch (candidate) {
					expectRetry(candidate);
					break;
				}
			}
			expect(acceptedMutations).toBeGreaterThanOrEqual(2);
			let error: unknown;
			try {
				store.commitMutation(messageInput(clock, 'maintenance-user', 'foreground exhausted', 'maintenance-final'));
			} catch (candidate) {
				error = candidate;
			}
			expectRetry(error);
			const beforeCleanup = store.storageAccounting();
			clock.set(clock.now() + DAY + HOUR + 1);
			const cleanup = store.runCleanup(clock.now());
			const afterCleanup = store.storageAccounting();
			const maintenanceDay = new Date(clock.now()).toISOString().slice(0, 10);
			const budgetRows = state.storage.sql.exec<{
				day: string;
				foreground_writes: number;
				maintenance_writes: number;
			}>('SELECT day, foreground_writes, maintenance_writes FROM resource_budgets WHERE day IN (?, ?) ORDER BY day', foregroundDay, maintenanceDay).toArray();
			const foregroundBudget = budgetRows.find((row) => row.day === foregroundDay);
			const maintenanceBudget = budgetRows.find((row) => row.day === maintenanceDay);
			expect(cleanup.deleted_transitions).toBe(acceptedMutations);
			expect(cleanup.deleted_messages).toBe(acceptedMutations);
			expect(BigInt(cleanup.history_floor)).toBeGreaterThan(1n);
			expect(foregroundBudget?.foreground_writes).toBeGreaterThan(0);
			expect(foregroundBudget?.foreground_writes).toBeLessThanOrEqual(config.foregroundWritesPerDay);
			expect(maintenanceBudget?.maintenance_writes).toBeGreaterThan(0);
			expect(afterCleanup.writes - beforeCleanup.writes).toBeGreaterThan(0);
			return { cleanup, acceptedMutations, foregroundBudget, maintenanceBudget, observedCleanup: diffAccounting(afterCleanup, beforeCleanup) };
		});
		console.info('accounting-maintenance-reserve', JSON.stringify(result));
	});

	it('measures every Store reservation boundary used by runtime operations', async () => {
		const stub = env.DEMO.getByName('accounting-operation-matrix-v1');
		const config = accountingConfig();
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, config, clock);
			store.initialize();
			const costs: Array<Record<string, unknown>> = [];
			const measure = (label: string, callback: () => unknown) => {
				const beforeBudget = store.budget();
				const beforeAccounting = store.storageAccounting();
				const value = callback();
				const afterAccounting = store.storageAccounting();
				const afterBudget = store.budget();
				const observed = diffAccounting(afterAccounting, beforeAccounting);
				const reserved = diffBudget(afterBudget, beforeBudget);
				costs.push({ label, observed, reserved, withinReserve: observed.reads <= reserved.reads && observed.writes <= reserved.writes });
				return value;
			};
			const measureAsync = async (label: string, callback: () => Promise<unknown>) => {
				const beforeBudget = store.budget();
				const beforeAccounting = store.storageAccounting();
				const value = await callback();
				const afterAccounting = store.storageAccounting();
				const afterBudget = store.budget();
				const observed = diffAccounting(afterAccounting, beforeAccounting);
				const reserved = diffBudget(afterBudget, beforeBudget);
				costs.push({ label, observed, reserved, withinReserve: observed.reads <= reserved.reads && observed.writes <= reserved.writes });
				return value;
			};

			measure('auth attempt reservation', () => store.reserveAuthAttempt({ ipKey: 'matrix-auth', now: clock.now() }));
			measure('history quota reservation', () => store.reserveHistory({ userId: 'matrix-history-user', ipKey: 'matrix-history-ip', now: clock.now() }));
			measure('frame reservation', () => store.reserveFrames({ ipKey: 'matrix-frame-ip', now: clock.now(), count: 1 }));
			measure('connection admission reservation', () => store.reserveConnection({ ipKey: 'matrix-connection-ip', tier: 'pending', now: clock.now() }));
			measure('identity registration', () => store.registerIdentity({
				userId: 'matrix-user',
				name: 'Matrix user',
				userHandle: 'matrix-handle',
				credential: { credentialId: 'matrix-credential', userId: 'matrix-user', publicKey: 'matrix-public-key', counter: 0 },
				now: clock.now(),
				ipKey: 'matrix-registration-ip',
			}));
			measure('credential lookup', () => store.getCredential('matrix-credential'));
			measure('identity lookup', () => store.getIdentity('matrix-user'));
			measure('identity count', () => store.countIdentities());
			measure('credential IDs lookup', () => store.credentialIdsForUser('matrix-user'));
			measure('credential counter update', () => store.updateCredentialCounter('matrix-credential', 1));

			const identity = { user_id: 'matrix-user', name: 'Matrix user', tier: 'registered' as const };
			const create = measure('message create', () => store.commitMutation({
				userId: 'matrix-user', ipKey: 'matrix-post-ip', requestId: 'matrix-message', method: 'message', now: clock.now(),
				params: { room_id: 'general', body: { text: 'matrix message', format: 'plain' } }, identity,
			}));
			measure('deduplicated mutation retry', () => store.commitMutation({
				userId: 'matrix-user', ipKey: 'matrix-post-ip', requestId: 'matrix-message', method: 'message', now: clock.now(),
				params: { room_id: 'general', body: { text: 'matrix message', format: 'plain' } }, identity,
			}));
			measure('thread create', () => store.commitMutation({
				userId: 'matrix-user', ipKey: 'matrix-thread-ip', requestId: 'matrix-thread', method: 'thread', now: clock.now(),
				params: { room_id: 'general', title: 'Matrix thread' }, identity,
			}));
			measure('registered nick mutation', () => store.commitMutation({
				userId: 'matrix-user', ipKey: 'matrix-nick-ip', requestId: 'matrix-nick', method: 'nick', now: clock.now(),
				params: { name: 'Matrix renamed' }, identity,
			}));
			measure('history page', () => store.historyPage({ roomId: 'general', limit: 50, now: clock.now() }));
			measure('room state announcement', () => store.getRoomState());
			measure('thread listing', () => store.getThreads());
			measure('domain room listing', () => store.room());
			measure('admission snapshot', () => store.admission());
			clock.set(clock.now() + DAY + HOUR + 1);
			measure('cleanup', () => store.runCleanup(clock.now()));
			await measureAsync('alarm scheduling', () => store.scheduleAlarm(clock.now() + 1_000, clock.now()));

			expect((create as { result: { message_id?: string } }).result.message_id).toBeTruthy();
			expect(costs).toHaveLength(21);
			return { costs };
		});
		console.info('accounting-operation-matrix', JSON.stringify(result));
		for (const operation of result.costs as Array<{ label: string; withinReserve: boolean }>) {
			expect(operation.withinReserve, `${operation.label} exceeded its reservation`).toBe(true);
		}
	});

	it('records actual SQLite query plans for history, cleanup, thread, dedup, and limiter paths', async () => {
		const stub = env.DEMO.getByName('accounting-query-plans-v1');
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, accountingConfig(), clock);
			store.initialize();
			for (let index = 0; index < 4; index += 1) {
				store.commitMutation(messageInput(clock, 'plan-user', `plan-${index}`, `plan-${index}`));
			}
			const sql = state.storage.sql;
			const plans = {
				history: explain(sql, `EXPLAIN QUERY PLAN
					SELECT room_id, log_id, commit_ms, message_id, snapshot_json, previous_thread_id, thread_id
					FROM transitions WHERE room_id = ? AND log_id >= ? AND log_id <= ?
					ORDER BY log_id ASC LIMIT ?`, 'general', 1, Number.MAX_SAFE_INTEGER, 20),
				cleanup: explain(sql, `EXPLAIN QUERY PLAN
					SELECT log_id FROM transitions INDEXED BY transitions_retention_idx
					WHERE room_id = ? AND commit_ms < ? AND log_id >= ?
					ORDER BY commit_ms ASC, log_id ASC LIMIT ?`, 'general', clock.now() - DAY, 1, 100),
				cleanupDelete: explain(sql, `EXPLAIN QUERY PLAN
					SELECT log_id FROM transitions
					WHERE room_id = ? AND log_id < ?
					ORDER BY log_id ASC LIMIT ?`, 'general', 100, 100),
				threadBefore: explain(sql, `EXPLAIN QUERY PLAN
					SELECT room_id, log_id, commit_ms, message_id, snapshot_json, previous_thread_id, thread_id
					FROM transitions WHERE room_id = ? AND log_id >= ? AND log_id <= ? AND previous_thread_id = ?
					ORDER BY log_id ASC LIMIT ?`, 'general', 1, Number.MAX_SAFE_INTEGER, 't_1', 51),
				threadAfter: explain(sql, `EXPLAIN QUERY PLAN
					SELECT room_id, log_id, commit_ms, message_id, snapshot_json, previous_thread_id, thread_id
					FROM transitions WHERE room_id = ? AND log_id >= ? AND log_id <= ? AND thread_id = ?
					ORDER BY log_id ASC LIMIT ?`, 'general', 1, Number.MAX_SAFE_INTEGER, 't_1', 51),
				dedupExpiry: explain(sql, 'EXPLAIN QUERY PLAN SELECT user_id, request_id FROM accepted_requests WHERE expires_ms <= ? ORDER BY expires_ms ASC LIMIT ?', clock.now(), 100),
				limiterExpiry: explain(sql, 'EXPLAIN QUERY PLAN SELECT scope, principal_key FROM principal_limits WHERE updated_ms < ? ORDER BY updated_ms ASC LIMIT ?', clock.now() - DAY, 100),
			};
			return { plans, databaseSize: store.databaseSize() };
		});
		console.info('accounting-query-plans', JSON.stringify(result));
		expect(result.plans.history.some((detail) => /SEARCH transitions USING/i.test(detail))).toBe(true);
		expect(result.plans.cleanup.some((detail) => /transitions_retention_idx/i.test(detail))).toBe(true);
		expect(result.plans.cleanupDelete.some((detail) => /SEARCH transitions USING/i.test(detail))).toBe(true);
		expect(result.plans.threadBefore.some((detail) => /transitions_thread_before_idx/i.test(detail))).toBe(true);
		expect(result.plans.threadAfter.some((detail) => /transitions_thread_after_idx/i.test(detail))).toBe(true);
		expect(result.plans.dedupExpiry.some((detail) => /accepted_requests.*expiry|expiry.*accepted_requests/i.test(detail))).toBe(true);
	});
});
