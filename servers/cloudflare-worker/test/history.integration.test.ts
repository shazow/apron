import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { RETENTION_MS, Store, StoreError, type StoreConfig, type StoreMutationInput, type StoreMutationResult } from "../src/store";

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
	config: Partial<StoreConfig> = {},
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

function op(
	clock: TestClock,
	requestId: string,
	method: string,
	params: Record<string, unknown>,
	userId = "alice",
): StoreMutationInput {
	return {
		userId,
		tier: "anonymous",
		ipKey: "history-ip",
		requestId,
		method,
		now: clock.value,
		params,
		identity: { user_id: userId, name: "History Tester" },
	};
}

function messageInput(clock: TestClock, requestId: string, params: Record<string, unknown>): StoreMutationInput {
	return op(clock, requestId, "message", { room_id: "general", ...params });
}

function logId(result: StoreMutationResult): bigint {
	const value = result.broadcasts[0]?.params.log_id ?? result.room?.log_id;
	if (typeof value !== "string") throw new Error("mutation did not produce a record");
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

const ROOMY: Partial<StoreConfig> = {
	anonymousPostsPerMinute: 1_000,
	ipPostsPerMinute: 1_000,
	globalPostsPerMinute: 1_000,
	anonymousPostsPerDay: 1_000,
	ipPostsPerDay: 1_000,
};

it("starts general with only its seeded creation record", async () => {
	await withStore("unused-boundary", {}, (store, clock) => {
		const room = store.getRoomState();
		expect(room).toEqual({
			room_id: "general", log_id: room.log_id, title: "General",
			latest_log_id: room.log_id, history_log_id: room.log_id,
		});
		expect(room.log_id).toMatch(/^[1-9][0-9]*$/);

		const page = store.history({ roomId: "general", after: 0n, now: clock.value });
		expect(page.rooms).toEqual([room]);
		expect(page.entries).toEqual([]);
		expect(page.reactions).toBeUndefined();
		expect(page.first_id).toBe(room.log_id);
		expect(page.last_id).toBe(room.log_id);
		expect(page.more).toBe(false);
		expect(page.latest_log_id).toBe(room.log_id);
		expect(page.history_log_id).toBe(room.log_id);
	});
});

it("returns inclusive, bounded forward and backward pages with true bounds", async () => {
	await withStore("pagination", {}, (store, clock) => {
		const general = store.getRoomState();
		const logs: bigint[] = [];
		for (let index = 0; index < 51; index += 1) {
			if (index > 0 && index % 5 === 0) clock.value += 61_000;
			logs.push(logId(store.mutate(messageInput(clock, `page-${index}`, {
				body: { format: "plain", text: `entry-${index}` },
			}))));
		}

		const forward = store.history({ roomId: "general", after: logs[0], limit: 2, now: clock.value });
		expect(forward.entries.map((entry) => BigInt(entry.log_id))).toEqual(logs.slice(0, 2));
		expect(forward.first_id).toBe(String(logs[0]));
		expect(forward.last_id).toBe(String(logs[1]));
		expect(forward.more).toBe(true);
		expect(forward.latest_log_id).toBe(String(logs[50]));
		expect(forward.history_log_id).toBe(general.log_id);

		const forwardContinuation = store.history({ roomId: "general", after: logs[1] + 1n, limit: 2, now: clock.value });
		expect(forwardContinuation.entries.map((entry) => BigInt(entry.log_id))).toEqual(logs.slice(2, 4));

		const backward = store.history({ roomId: "general", before: logs[50], limit: 2, now: clock.value });
		expect(backward.entries.map((entry) => BigInt(entry.log_id))).toEqual(logs.slice(49, 51));
		expect(backward.first_id).toBe(String(logs[49]));
		expect(backward.last_id).toBe(String(logs[50]));
		expect(backward.more).toBe(true);

		const backwardContinuation = store.history({ roomId: "general", before: BigInt(backward.first_id!) - 1n, limit: 2, now: clock.value });
		expect(backwardContinuation.entries.map((entry) => BigInt(entry.log_id))).toEqual(logs.slice(47, 49));

		const bounded = store.history({ roomId: "general", after: logs[0], limit: 500, now: clock.value });
		expect(bounded.entries).toHaveLength(50);
		expect(bounded.first_id).toBe(String(logs[0]));
		expect(bounded.last_id).toBe(String(logs[49]));
		expect(bounded.more).toBe(true);
		const finalPage = store.history({ roomId: "general", after: logs[49] + 1n, limit: 50, now: clock.value });
		expect(finalPage.entries.map((entry) => BigInt(entry.log_id))).toEqual([logs[50]]);
		expect(finalPage.more).toBe(false);

		const limitedEmpty = store.history({ roomId: "general", after: logs[50] + 1n, limit: 50, now: clock.value });
		expect(limitedEmpty).toEqual({ entries: [], more: false, latest_log_id: String(logs[50]), history_log_id: general.log_id });

		const exactRange = store.history({ roomId: "general", after: logs[10], before: logs[11], limit: 50, now: clock.value });
		expect(exactRange.entries.map((entry) => BigInt(entry.log_id))).toEqual(logs.slice(10, 12));
		expect(exactRange.more).toBe(false);
	});
});

it("counts records of every kind toward limit and spans first_id/last_id across kinds", async () => {
	await withStore("mixed-kinds", ROOMY, (store, clock) => {
		const created = store.mutate(op(clock, "thread", "room_set", { parent_room_id: "general", title: "Mixed" }));
		const roomId = String(created.result.room_id);
		const message = store.mutate(op(clock, "m1", "message", { room_id: roomId, body: { text: "first" } }));
		const reaction = store.mutate(op(clock, "r1", "reactions", { message_id: message.result.message_id, emojis: ["👍"] }, "bob"));
		const edit = store.mutate(op(clock, "m2", "message", { message_id: message.result.message_id, room_id: roomId, body: { text: "edited" } }));
		const renamed = store.mutate(op(clock, "rename", "room_set", { room_id: roomId, title: "Renamed" }, "bob"));
		const all = [created, message, reaction, edit, renamed].map((result) => String(logId(result)));

		const first = store.history({ roomId, after: 0n, limit: 2, now: clock.value });
		expect(first.rooms?.map((room) => room.log_id)).toEqual([all[0]]);
		expect(first.entries.map((entry) => entry.log_id)).toEqual([all[1]]);
		expect(first.reactions).toBeUndefined();
		expect([first.first_id, first.last_id, first.more]).toEqual([all[0], all[1], true]);
		// Room records in history carry the room's delivery fields, like announcements.
		expect(first.rooms?.[0]).toMatchObject({ title: "Mixed", latest_log_id: all[4], history_log_id: all[0] });

		const second = store.history({ roomId, after: BigInt(first.last_id!) + 1n, limit: 2, now: clock.value });
		expect(second.rooms).toBeUndefined();
		expect(second.reactions?.map((record) => record.log_id)).toEqual([all[2]]);
		expect(second.entries.map((entry) => entry.log_id)).toEqual([all[3]]);
		expect([second.first_id, second.last_id, second.more]).toEqual([all[2], all[3], true]);

		const third = store.history({ roomId, after: BigInt(second.last_id!) + 1n, limit: 2, now: clock.value });
		expect(third.rooms?.map((room) => room.title)).toEqual(["Renamed"]);
		expect(third.entries).toEqual([]);
		expect([third.first_id, third.last_id, third.more]).toEqual([all[4], all[4], false]);

		const newest = store.history({ roomId, limit: 3, now: clock.value });
		expect([newest.first_id, newest.last_id, newest.more]).toEqual([all[2], all[4], true]);
		expect(newest.reactions?.map((record) => record.log_id)).toEqual([all[2]]);
		expect(newest.entries.map((entry) => entry.log_id)).toEqual([all[3]]);
		expect(newest.rooms?.map((room) => room.log_id)).toEqual([all[4]]);

		// The thread's log is separate from its parent's.
		const parent = store.history({ roomId: "general", after: 0n, limit: 50, now: clock.value });
		expect(parent.entries).toEqual([]);
		expect(parent.rooms?.map((room) => room.room_id)).toEqual(["general"]);
	});
});

it("stops at a UTF-8 response byte cap without skipping a contiguous record", async () => {
	await withStore("byte-cap", {}, (store, clock) => {
		const first = logId(store.mutate(messageInput(clock, "byte-1", { body: { format: "plain", text: "first" } })));
		const second = logId(store.mutate(messageInput(clock, "byte-2", { body: { format: "plain", text: "second" } })));
		const large = logId(store.mutate(messageInput(clock, "byte-3", { body: { format: "plain", text: "x".repeat(3_800) } })));

		const capped = store.history({ roomId: "general", after: first, limit: 50, maxBytes: 4_500, now: clock.value });
		expect(capped.entries.map((entry) => BigInt(entry.log_id))).toEqual([first, second]);
		expect(capped.first_id).toBe(String(first));
		expect(capped.last_id).toBe(String(second));
		expect(capped.more).toBe(true);

		const continuation = store.history({ roomId: "general", after: second + 1n, limit: 50, maxBytes: 256 * 1024, now: clock.value });
		expect(continuation.entries.map((entry) => BigInt(entry.log_id))).toEqual([large]);
		expect(continuation.more).toBe(false);
	});
});

it("rejects unknown rooms and returns a known empty thread's creation record", async () => {
	await withStore("room-filters", {}, (store, clock) => {
		const created = store.mutate(op(clock, "empty-thread", "room_set", { parent_room_id: "general", title: "No messages yet" }));
		const roomId = String(created.result.room_id);
		store.mutate(messageInput(clock, "outside-thread", { body: { format: "plain", text: "outside the empty thread" } }));
		const empty = store.history({ roomId, limit: 50, now: clock.value });
		expect(empty.rooms?.map((room) => room.room_id)).toEqual([roomId]);
		expect(empty.entries).toEqual([]);
		expect(empty.latest_log_id).toBe(roomId);
		expect(empty.history_log_id).toBe(roomId);

		expect(errorCode(() => store.history({ roomId: "missing", now: clock.value }))).toBe("invalid_params");
		expect(errorCode(() => store.history({ roomId: "", now: clock.value }))).toBe("invalid_params");
	});
});

it("advances a fully expired head past the room and keeps future IDs valid", async () => {
	await withStore("expired-head", {}, (store, clock) => {
		const logs = [0, 1, 2].map((index) => logId(store.mutate(messageInput(clock, `expired-${index}`, {
			body: { format: "plain", text: `expired-${index}` },
		}))));
		expect(store.getRoomState().latest_log_id).toBe(String(logs[2]));

		clock.value += RETENTION_MS + 1;
		const cleanup = store.runCleanup(clock.value);
		const expectedFloor = logs[2] + 1n;
		expect(cleanup.history_floor).toBe(String(expectedFloor));
		expect(cleanup.latest_id).toBe(String(logs[2]));
		const room = store.getRoomState();
		expect(room.history_log_id).toBeNull();
		expect(room.latest_log_id).toBe(String(logs[2]));

		const empty = store.history({ roomId: "general", after: 0n, limit: 50, now: clock.value });
		expect(empty).toEqual({ entries: [], more: false, latest_log_id: String(logs[2]), history_log_id: null });

		const future = logId(store.mutate(messageInput(clock, "after-expiry", { body: { format: "plain", text: "new" } })));
		expect(future).toBeGreaterThanOrEqual(expectedFloor);
		expect(store.getRoomState().latest_log_id).toBe(String(future));
		expect(store.getRoomState().history_log_id).toBe(String(expectedFloor));
	});
});

it("continues bounded cleanup while retaining recent edits and moves out of a thread", async () => {
	await withStore("cleanup-continuation", { ...ROOMY, cleanupBatch: 2 }, (store, clock) => {
		const root = store.mutate(messageInput(clock, "cleanup-root", { body: { format: "plain", text: "root-old" } }));
		const rootId = String(root.result.message_id);
		const thread = store.mutate(op(clock, "cleanup-thread", "room_set", { parent_room_id: "general", title: "Retained thread", intro_message: { message_id: rootId } }));
		const threadId = String(thread.result.room_id);
		const reply = store.mutate(op(clock, "cleanup-reply", "message", { room_id: threadId, body: { format: "plain", text: "reply-old" } }));
		const replyId = String(reply.result.message_id);
		store.mutate(messageInput(clock, "cleanup-padding-1", { body: { format: "plain", text: "padding-1" } }));
		const lastExpiredLog = logId(store.mutate(messageInput(clock, "cleanup-padding-2", { body: { format: "plain", text: "padding-2" } })));

		// The creation records expire, but the latest root edit and the move of
		// the reply out of the thread remain inside the retention interval.
		clock.value += RETENTION_MS - 1_000;
		const recentRootLog = logId(store.mutate(messageInput(clock, "cleanup-root-edit", { message_id: rootId, body: { format: "plain", text: "root-recent" } })));
		const departureLog = logId(store.mutate(messageInput(clock, "cleanup-reply-move", { message_id: replyId, body: { format: "plain", text: "reply-departed" } })));

		clock.value += 2_000;
		const floors: string[] = [];
		let runs = 0;
		for (; runs < 12; runs += 1) {
			const result = store.runCleanup(clock.value);
			floors.push(result.history_floor);
			if (!result.did_work && result.next_due_ms > clock.value) break;
			clock.value = result.next_due_ms + 1;
		}
		expect(runs).toBeGreaterThan(1);
		expect(floors).toEqual([...floors].sort((left, right) => Number(BigInt(left) - BigInt(right))));

		const room = store.getRoomState();
		expect(BigInt(room.history_log_id!)).toBe(lastExpiredLog + 1n);
		expect(BigInt(room.latest_log_id)).toBe(departureLog);
		const history = store.history({ roomId: "general", after: 0n, limit: 50, now: clock.value });
		expect(history.history_log_id).toBe(room.history_log_id);
		expect(history.entries.map((entry) => BigInt(entry.log_id))).toEqual([recentRootLog, departureLog]);
		expect(history.entries[0].body?.text).toBe("root-recent");
		expect(history.entries[1]).toMatchObject({ room_id: "general", body: { text: "reply-departed" } });

		// The thread keeps its room record: the move still touches its log.
		const retained = store.getRoomState(threadId);
		expect(retained).toMatchObject({ log_id: threadId, title: "Retained thread", latest_log_id: String(departureLog) });
		expect(retained.intro_message).toMatchObject({ message_id: rootId, body: { text: "root-recent" } });
		expect(retained.history_log_id).toBe(room.history_log_id);
		const threadHistory = store.history({ roomId: threadId, limit: 50, now: clock.value });
		expect(threadHistory.entries.map((entry) => BigInt(entry.log_id))).toEqual([departureLog]);
		expect(threadHistory.rooms).toBeUndefined();
	});
});

it("removes thread rooms whose entire log expired and keeps rooms with retained records", async () => {
	await withStore("thread-expiry", ROOMY, (store, clock, state) => {
		const stale = String(store.mutate(op(clock, "stale", "room_set", { parent_room_id: "general", title: "Stale" })).result.room_id);
		store.mutate(op(clock, "stale-post", "message", { room_id: stale, body: { text: "old" } }));
		const active = String(store.mutate(op(clock, "active", "room_set", { parent_room_id: "general", title: "Active" })).result.room_id);
		clock.value += RETENTION_MS - 60_000;
		const recent = store.mutate(op(clock, "active-post", "message", { room_id: active, body: { text: "recent" } }));
		clock.value += 120_000;

		const removed: string[] = [];
		for (let run = 0; run < 8; run += 1) {
			const result = store.runCleanup(clock.value);
			removed.push(...result.removed_rooms);
			if (!result.did_work && result.next_due_ms > clock.value) break;
			clock.value = result.next_due_ms + 1;
		}
		expect(removed).toEqual([stale]);
		expect(store.getRoom(stale)).toBeNull();
		expect(errorCode(() => store.mutate(op(clock, "late", "message", { room_id: stale, body: { text: "late" } })))).toBe("invalid_params");
		expect(errorCode(() => store.history({ roomId: stale, now: clock.value }))).toBe("invalid_params");

		// The active thread's creation record expired, so its room record is
		// still announced (with its original log_id) while history starts later.
		const kept = store.getRoomState(active);
		expect(kept.log_id).toBe(active);
		expect(BigInt(kept.history_log_id!)).toBeGreaterThan(BigInt(active));
		expect(kept.latest_log_id).toBe(recent.message?.log_id);
		expect(store.listRooms().map((room) => room.room_id)).toEqual(["general", active]);
		// The released slot allows another thread under a one-thread ceiling.
		const limited = new Store(state, { ...ROOMY, maxThreads: 2 }, clock.clock);
		limited.initialize();
		expect(limited.mutate(op(clock, "replacement", "room_set", { parent_room_id: "general", title: "Replacement" })).result.room_id).toBeTruthy();
	});
});

it("does not exceed the native cleanup reservation for a full bounded batch", async () => {
	await withStore("cleanup-cost", { cleanupBatch: 100 }, (store, clock, state) => {
		// Seed the bounded native fixture directly so this test exercises the
		// cleanup reservation rather than spending the foreground post quota.
		// Every source class has a full batch ready for the same alarm.
		const sql = state.storage.sql;
		const expiredAt = clock.value - RETENTION_MS - 1;
		sql.exec("DELETE FROM records");
		for (let index = 1; index <= 100; index += 1) {
			const messageId = `${index}`;
			const userId = `expired-user-${index}`;
			const snapshot = JSON.stringify({
				message_id: messageId, log_id: messageId, room_id: "general",
				from: { user_id: userId, name: "Expired" },
				body: { format: "plain", text: `expired-${index}` },
			});
			sql.exec("INSERT INTO records (room_id, log_id, commit_ms, kind, record_json) VALUES ('general', ?, ?, 'message', ?)", index, expiredAt, snapshot);
			sql.exec("INSERT INTO message_state (message_id, room_id, latest_log_id, snapshot_json, author_id) VALUES (?, 'general', ?, ?, ?)", messageId, index, snapshot, userId);
			sql.exec("INSERT INTO reaction_state (message_id, user_id, log_id, from_json, emojis_json) VALUES (?, ?, ?, ?, '[\"x\"]')", messageId, userId, index, JSON.stringify({ user_id: userId }));
			sql.exec(
				"INSERT INTO accepted_requests (user_id, request_id, digest, result_json, transition_json, expires_ms) VALUES (?, ?, ?, ?, NULL, ?)",
				userId, `request-${index}`, `digest-${index}`, JSON.stringify({ message_id: messageId }), expiredAt,
			);
			sql.exec(
				"INSERT INTO principal_limits (scope, principal_key, post_events_json, auth_events_json, history_events_json, admission_events_json, day, posts_day, registrations_day, updated_ms) VALUES (?, ?, '[]', '[]', '[]', '[]', ?, 0, 0, ?)",
				"fixture", `limiter-${index}`, "1970-01-01", expiredAt,
			);
			sql.exec(
				"INSERT INTO rooms (room_id, parent_room_id, created_log_id, record_log_id, latest_log_id, intro_message_id, fields_json, created_ms, updated_ms) VALUES (?, 'general', ?, ?, ?, NULL, '{}', ?, ?)",
				`thread-${index}`, index, index, index, expiredAt, expiredAt,
			);
		}
		sql.exec("UPDATE _meta SET value = '100' WHERE key IN ('principal_limit_count', 'thread_count')");
		sql.exec("UPDATE rooms SET created_log_id = 1, record_log_id = 1, latest_log_id = 100 WHERE room_id = 'general'");
		sql.exec("UPDATE log_state SET last_log_id = 100, history_floor = 1, last_commit_ms = ?", expiredAt);
		sql.exec("UPDATE maintenance SET next_cleanup_ms = ?, cleanup_cutoff_ms = NULL, cleanup_cursor = NULL WHERE id = 1", clock.value);

		clock.value += RETENTION_MS + 1;
		const deleted = { records: 0, messages: 0, reactions: 0, rooms: 0, requests: 0, limiters: 0 };
		let lastResult: ReturnType<Store["runCleanup"]> | undefined;
		for (let run = 0; run < 10; run += 1) {
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
			expect(after.reads - before.reads).toBeLessThanOrEqual(after.reservedReads - before.reservedReads);
			deleted.records += lastResult.deleted_records;
			deleted.messages += lastResult.deleted_messages;
			deleted.reactions += lastResult.deleted_reactions;
			deleted.rooms += lastResult.removed_rooms.length;
			deleted.requests += lastResult.deleted_requests;
			deleted.limiters += lastResult.deleted_limiters;
			if (!lastResult.did_work && lastResult.next_due_ms > clock.value) break;
			clock.value = lastResult.next_due_ms + 1;
		}
		expect(deleted).toEqual({ records: 100, messages: 100, reactions: 100, rooms: 100, requests: 100, limiters: 100 });
		expect(lastResult?.history_floor).toBe("101");
		expect(lastResult?.latest_id).toBe("100");
		expect(lastResult?.did_work).toBe(false);
		expect(state.storage.sql.exec("SELECT value FROM _meta WHERE key = 'thread_count'").one().value).toBe("0");
		expect(store.getRoomState()).toMatchObject({ room_id: "general", latest_log_id: "100", history_log_id: null });
	});
});

it("finishes removing an expired thread room after a saturated batch", async () => {
	// Regression: the room was left over when the deletion pass filled the
	// batch, and the next run's idle check ended the job before removing it.
	await withStore("thread-expiry-saturated", { ...ROOMY, retentionMs: 60_000, cleanupBatch: 2, maxThreads: 1 }, (store, clock) => {
		const threadId = String(store.mutate(op(clock, "thread", "room_set", { parent_room_id: "general", title: "T" })).result.room_id);
		// Past the first hourly deadline; everything is older than retention.
		clock.value += 2 * 60 * 60_000;
		const removed: string[] = [];
		for (let run = 0; run < 8; run += 1) {
			const result = store.runCleanup(clock.value);
			removed.push(...result.removed_rooms);
			if (!result.did_work && result.next_due_ms > clock.value) {
				// The job must not end (hourly deadline) while the room remains.
				expect(result.next_due_ms - clock.value).toBeGreaterThan(1_000);
				break;
			}
			clock.value = result.next_due_ms + 1;
		}
		expect(removed).toEqual([threadId]);
		expect(store.listRooms().map((room) => room.room_id)).toEqual(["general"]);
		expect(store.mutate(op(clock, "thread-2", "room_set", { parent_room_id: "general", title: "T2" })).result.room_id).toBeTruthy();
	});
});

it("lists only rooms whose history_log_id moved, charged to maintenance", async () => {
	await withStore("changed-rooms", ROOMY, (store, clock) => {
		const stale = String(store.mutate(op(clock, "stale", "room_set", { parent_room_id: "general", title: "Stale" })).result.room_id);
		clock.value += RETENTION_MS - 60_000;
		store.mutate(op(clock, "stale-post", "message", { room_id: stale, body: { text: "keeps the room" } }));
		const fresh = String(store.mutate(op(clock, "fresh", "room_set", { parent_room_id: "general", title: "Fresh" })).result.room_id);
		clock.value += 120_000;
		const before = store.budget(clock.value);
		const result = store.runCleanup(clock.value);
		expect(result.history_floor).not.toBe(result.previous_floor);
		const changed = store.listRooms(clock.value, { maintenance: true, changedSinceFloor: Number(result.previous_floor) });
		const after = store.budget(clock.value);
		// General and the stale thread lost history; the fresh thread's bound
		// is its own creation record, which did not move.
		expect(changed.map((room) => room.room_id).sort()).toEqual(["general", stale].sort());
		expect(changed.map((room) => room.room_id)).not.toContain(fresh);
		expect(after.foreground_reads).toBe(before.foreground_reads);
		expect(after.maintenance_reads).toBeGreaterThan(before.maintenance_reads);
	});
});
