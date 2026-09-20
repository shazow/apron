import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { RETENTION_MS, Store, StoreError, type StoreMutationInput } from "../src/store";

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
	const stub = env.DEMO.getByName(`history-${name}-${crypto.randomUUID()}`);
	return runInDurableObject(stub, async (_instance, state) => {
		const clock = makeClock();
		const store = new Store(state, config, clock.clock);
		store.initialize();
		return fn(store, clock, state);
	});
}

function messageInput(
	clock: TestClock,
	userId: string,
	requestId: string,
	params: Record<string, unknown>,
	ipKey = "history-ip",
): StoreMutationInput {
	return {
		userId,
		tier: "anonymous",
		ipKey,
		requestId,
		method: "message",
		roomId: "general",
		now: clock.value,
		params: { room_id: "general", ...params },
		identity: { user_id: userId, name: "History Tester" },
	};
}

function threadInput(
	clock: TestClock,
	userId: string,
	requestId: string,
	thread: StoreMutationInput["thread"],
	ipKey = "history-ip",
): StoreMutationInput {
	return {
		userId,
		tier: "anonymous",
		ipKey,
		requestId,
		method: "thread",
		roomId: "general",
		now: clock.value,
		thread,
		params: { room_id: "general" },
		identity: { user_id: userId, name: "History Tester" },
	};
}

function logId(result: ReturnType<Store["mutate"]>): bigint {
	const value = result.transition?.log_id;
	if (value === undefined) throw new Error("mutation did not produce a transition");
	return BigInt(value);
}

function errorCode(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		if (error instanceof StoreError) return error.code;
		throw error;
	}
	throw new Error("expected StoreError");
}

it("returns inclusive, bounded forward and backward pages with true bounds", async () => {
	await withStore("pagination", {}, (store, clock) => {
		const logs: bigint[] = [];
		for (let index = 0; index < 51; index += 1) {
			if (index > 0 && index % 5 === 0) clock.value += 61_000;
			logs.push(logId(store.mutate(messageInput(clock, "alice", `page-${index}`, {
				body: { format: "plain", text: `entry-${index}` },
			}))));
		}

		const forward = store.history({ roomId: "general", after: logs[0], limit: 2, now: clock.value });
		expect(forward.entries.map((entry) => BigInt(entry.log_id))).toEqual(logs.slice(0, 2));
		expect(forward.first_id).toBe(String(logs[0]));
		expect(forward.last_id).toBe(String(logs[1]));
		expect(forward.more).toBe(true);

		const forwardContinuation = store.history({
			roomId: "general",
			after: logs[1] + 1n,
			limit: 2,
			now: clock.value,
		});
		expect(forwardContinuation.entries.map((entry) => BigInt(entry.log_id))).toEqual(logs.slice(2, 4));

		const backward = store.history({ roomId: "general", before: logs[50], limit: 2, now: clock.value });
		expect(backward.entries.map((entry) => BigInt(entry.log_id))).toEqual(logs.slice(49, 51));
		expect(backward.first_id).toBe(String(logs[49]));
		expect(backward.last_id).toBe(String(logs[50]));
		expect(backward.more).toBe(true);

		const backwardContinuation = store.history({
			roomId: "general",
			before: BigInt(backward.first_id!) - 1n,
			limit: 2,
			now: clock.value,
		});
		expect(backwardContinuation.entries.map((entry) => BigInt(entry.log_id))).toEqual(logs.slice(47, 49));

		const bounded = store.history({ roomId: "general", after: logs[0], limit: 500, now: clock.value });
		expect(bounded.entries).toHaveLength(50);
		expect(bounded.first_id).toBe(String(logs[0]));
		expect(bounded.last_id).toBe(String(logs[49]));
		expect(bounded.more).toBe(true);
		const finalPage = store.history({ roomId: "general", after: logs[49] + 1n, limit: 50, now: clock.value });
		expect(finalPage.entries.map((entry) => BigInt(entry.log_id))).toEqual([logs[50]]);
		expect(finalPage.more).toBe(false);

		const exactRange = store.history({ roomId: "general", after: logs[10], before: logs[11], limit: 50, now: clock.value });
		expect(exactRange.entries.map((entry) => BigInt(entry.log_id))).toEqual(logs.slice(10, 12));
		expect(exactRange.more).toBe(false);
	});
});

it("stops at a UTF-8 response byte cap without skipping a contiguous entry", async () => {
	await withStore("byte-cap", {}, (store, clock) => {
		const first = logId(store.mutate(messageInput(clock, "alice", "byte-1", {
			body: { format: "plain", text: "first" },
		})));
		const second = logId(store.mutate(messageInput(clock, "alice", "byte-2", {
			body: { format: "plain", text: "second" },
		})));
		const large = logId(store.mutate(messageInput(clock, "alice", "byte-3", {
			body: { format: "plain", text: "x".repeat(3_800) },
		})));

		const capped = store.history({
			roomId: "general",
			after: first,
			limit: 50,
			maxBytes: 4_500,
			now: clock.value,
		});
		expect(capped.entries.map((entry) => BigInt(entry.log_id))).toEqual([first, second]);
		expect(capped.first_id).toBe(String(first));
		expect(capped.last_id).toBe(String(second));
		expect(capped.more).toBe(true);

		const continuation = store.history({
			roomId: "general",
			after: second + 1n,
			limit: 50,
			maxBytes: 256 * 1024,
			now: clock.value,
		});
		expect(continuation.entries.map((entry) => BigInt(entry.log_id))).toEqual([large]);
		expect(continuation.first_id).toBe(String(large));
		expect(continuation.last_id).toBe(String(large));
		expect(continuation.more).toBe(false);
	});
});

it("distinguishes unknown threads from known empty threads", async () => {
	await withStore("thread-filters", {}, (store, clock) => {
		const created = store.mutateThread(threadInput(clock, "alice", "empty-thread", { title: "No messages yet" }));
		const threadId = String(created.result.thread_id);
		const empty = store.history({ roomId: "general", threadId, limit: 50, now: clock.value });
		expect(empty.entries).toEqual([]);
		expect(empty.more).toBe(false);
		expect(empty.first_id).toBeUndefined();
		expect(empty.last_id).toBeUndefined();

		expect(errorCode(() => store.history({ roomId: "general", threadId: "t_missing", now: clock.value }))).toBe("invalid_params");
	});
});

it("advances a fully expired nonzero head to head plus one and keeps future IDs valid", async () => {
	await withStore("expired-head", {}, (store, clock) => {
		const logs = [0, 1, 2].map((index) => logId(store.mutate(messageInput(clock, "alice", `expired-${index}`, {
			body: { format: "plain", text: `expired-${index}` },
		}))));
		const head = store.getRoomState().latest_id;
		expect(head).toBe(String(logs[2]));

		clock.value += RETENTION_MS + 1;
		const cleanup = store.runCleanup(clock.value);
		const expectedFloor = logs[2] + 1n;
		expect(cleanup.history_floor).toBe(String(expectedFloor));
		expect(cleanup.latest_id).toBe(String(logs[2]));
		expect(store.getRoomState().history_floor).toBe(String(expectedFloor));

		const empty = store.history({ roomId: "general", after: 0n, limit: 50, now: clock.value });
		expect(empty.entries).toEqual([]);
		expect(empty.more).toBe(false);
		expect(empty.history_floor).toBe(String(expectedFloor));

		const future = logId(store.mutate(messageInput(clock, "alice", "after-expiry", {
			body: { format: "plain", text: "new" },
		})));
		expect(future).toBeGreaterThanOrEqual(expectedFloor);
		expect(store.getRoomState().latest_id).toBe(String(future));
	});
});

it("continues bounded cleanup while retaining recent roots and thread departures", async () => {
	await withStore("cleanup-continuation", {
		cleanupBatch: 2,
		anonymousPostsPerMinute: 20,
		globalPostsPerMinute: 100,
	}, (store, clock) => {
		const root = store.mutate(messageInput(clock, "alice", "cleanup-root", {
			body: { format: "plain", text: "root-old" },
		}));
		const rootId = String(root.result.message_id);
		const thread = store.mutateThread(threadInput(clock, "alice", "cleanup-thread", {
			title: "Retained thread",
			rootMessageId: rootId,
		}));
		const threadId = String(thread.result.thread_id);
		const reply = store.mutate(messageInput(clock, "alice", "cleanup-reply", {
			body: { format: "plain", text: "reply-old" },
			thread_id: threadId,
		}));
		const replyId = String(reply.result.message_id);
		store.mutate(messageInput(clock, "alice", "cleanup-padding-1", {
			body: { format: "plain", text: "padding-1" },
		}));
		const oldPaddingTwo = store.mutate(messageInput(clock, "alice", "cleanup-padding-2", {
			body: { format: "plain", text: "padding-2" },
		}));
		const lastExpiredLog = logId(oldPaddingTwo);

		// The creation transitions will expire, but the latest root edit and
		// departure transition remain inside the retention interval.
		clock.value += RETENTION_MS - 1_000;
		const editedRoot = store.mutate(messageInput(clock, "alice", "cleanup-root-edit", {
			message_id: rootId,
			body: { format: "plain", text: "root-recent" },
		}));
		const movedReply = store.mutate(messageInput(clock, "alice", "cleanup-reply-move", {
			message_id: replyId,
			body: { format: "plain", text: "reply-departed" },
		}));
		const recentRootLog = logId(editedRoot);
		const departureLog = logId(movedReply);

		clock.value += 2_000;
		const floors: string[] = [];
		let runs = 0;
		for (; runs < 8; runs += 1) {
			const result = store.runCleanup(clock.value);
			floors.push(result.history_floor);
			if (!result.did_work && result.next_due_ms > clock.value) break;
			clock.value = result.next_due_ms + 1;
		}
		expect(runs).toBeGreaterThan(1);
		expect(floors).toEqual([...floors].sort((left, right) => Number(BigInt(left) - BigInt(right))));

		const room = store.getRoomState();
		expect(BigInt(room.history_floor)).toBe(lastExpiredLog + 1n);
		expect(BigInt(room.history_floor)).toBeLessThan(recentRootLog);
		expect(BigInt(room.latest_id)).toBe(departureLog);
		const history = store.history({ roomId: "general", after: 0n, limit: 50, now: clock.value });
		expect(history.entries.map((entry) => BigInt(entry.log_id))).toEqual([recentRootLog, departureLog]);
		expect((history.entries[0].message.body as Record<string, unknown> | undefined)?.text).toBe("root-recent");
		expect((history.entries[1].message.body as Record<string, unknown> | undefined)?.text).toBe("reply-departed");

		const retainedThread = store.getThread(threadId);
		expect(retainedThread?.root_message_id).toBe(rootId);
		const threadHistory = store.history({ roomId: "general", threadId, limit: 50, now: clock.value });
		expect(threadHistory.entries.map((entry) => BigInt(entry.log_id))).toEqual([departureLog]);
	});
});

it("does not exceed the native cleanup reservation for a full bounded batch", async () => {
	await withStore("cleanup-cost", {
		cleanupBatch: 100,
	}, (store, clock, state) => {
		// Seed the bounded native fixture directly so this test exercises the
		// cleanup reservation rather than spending the foreground post quota.
		// Every source class has a full batch ready for the same alarm.
		const sql = state.storage.sql;
		const expiredAt = clock.value - RETENTION_MS - 1;
		for (let index = 1; index <= 100; index += 1) {
			const messageId = `expired-message-${index}`;
			const userId = `expired-user-${index}`;
			const snapshot = JSON.stringify({
				message_id: messageId,
				from: { user_id: userId, name: "Expired" },
				body: { format: "plain", text: `expired-${index}` },
			});
			sql.exec(
				"INSERT INTO transitions (room_id, log_id, commit_ms, message_id, snapshot_json, previous_thread_id, thread_id) VALUES (?, ?, ?, ?, ?, NULL, NULL)",
				"general", index, expiredAt, messageId, snapshot,
			);
			sql.exec(
				"INSERT INTO messages (room_id, message_id, latest_log_id, latest_commit_ms, snapshot_json, author_id, thread_id) VALUES (?, ?, ?, ?, ?, ?, NULL)",
				"general", messageId, index, expiredAt, snapshot, userId,
			);
			sql.exec(
				"INSERT INTO accepted_requests (user_id, request_id, digest, result_json, transition_json, expires_ms) VALUES (?, ?, ?, ?, NULL, ?)",
				userId, `request-${index}`, `digest-${index}`, JSON.stringify({ message_id: messageId }), expiredAt,
			);
			sql.exec(
				"INSERT INTO principal_limits (scope, principal_key, post_events_json, auth_events_json, history_events_json, admission_events_json, day, posts_day, registrations_day, updated_ms) VALUES (?, ?, '[]', '[]', '[]', '[]', ?, 0, 0, ?)",
				"fixture", `limiter-${index}`, "1970-01-01", expiredAt,
			);
		}
		sql.exec("UPDATE _meta SET value = '100' WHERE key = 'principal_limit_count'");
		sql.exec("UPDATE room_state SET last_log_id = ?, history_floor = 1, last_commit_ms = ? WHERE room_id = 'general'", 100, expiredAt);
		sql.exec("UPDATE maintenance SET next_cleanup_ms = ?, cleanup_cutoff_ms = NULL, cleanup_cursor = NULL WHERE id = 1", clock.value);

		const head = 100n;
		clock.value += RETENTION_MS + 1;

		const deleted = { transitions: 0, messages: 0, requests: 0, limiters: 0 };
		let lastResult: ReturnType<Store["runCleanup"]> | undefined;
		for (let run = 0; run < 8; run += 1) {
			const before = store.storageAccounting();
			try {
				lastResult = store.runCleanup(clock.value);
			} catch (error) {
				throw new Error(`full cleanup batch failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
			}
			const after = store.storageAccounting();
			// The native reservation is per bounded maintenance batch. This
			// catches an underestimated cleanupCost without requiring a mock SQL
			// cursor or relying on a particular number of index rows.
			expect(after.writes - before.writes).toBeLessThanOrEqual(after.reservedWrites - before.reservedWrites);
			deleted.transitions += lastResult.deleted_transitions;
			deleted.messages += lastResult.deleted_messages;
			deleted.requests += lastResult.deleted_requests;
			deleted.limiters += lastResult.deleted_limiters;
			if (!lastResult.did_work && lastResult.next_due_ms > clock.value) break;
			clock.value = lastResult.next_due_ms + 1;
		}
		expect(deleted.transitions).toBe(100);
		expect(deleted.messages).toBe(100);
		expect(deleted.requests).toBe(100);
		expect(deleted.limiters).toBe(100);
		expect(lastResult?.history_floor).toBe(String(head + 1n));
		expect(lastResult?.latest_id).toBe(String(head));
		expect(lastResult?.did_work).toBe(false);
	});
});
