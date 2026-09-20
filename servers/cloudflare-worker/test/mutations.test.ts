import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { RETENTION_MS, Store, StoreError, type StoreMutationInput } from "../src/store";

type TestClock = {
	value: number;
	readonly clock: { now(): number };
};

function makeClock(): TestClock {
	const testClock: TestClock = {
		value: Date.now() + 1_000,
		clock: { now: () => testClock.value },
	};
	return testClock;
}

async function withStore<T>(name: string, fn: (store: Store, clock: TestClock, state: DurableObjectState) => T | Promise<T>): Promise<T> {
	const stub = env.DEMO.getByName(`mutation-${name}-${crypto.randomUUID()}`);
	return runInDurableObject(stub, async (_instance, state) => {
		const clock = makeClock();
		const store = new Store(state, {}, clock.clock);
		store.initialize();
		return fn(store, clock, state);
	});
}

function messageInput(
	clock: TestClock,
	userId: string,
	requestId: string | undefined,
	params: Record<string, unknown>,
	ipKey = "ip-test",
): StoreMutationInput {
	return {
		userId,
		tier: "anonymous",
		ipKey,
		...(requestId === undefined ? {} : { requestId }),
		method: "message",
		roomId: "general",
		now: clock.value,
		params: { room_id: "general", ...params },
		identity: { user_id: userId, name: "Alice" },
	};
}

function threadInput(
	clock: TestClock,
	userId: string,
	requestId: string | undefined,
	thread: StoreMutationInput["thread"],
	ipKey = "ip-test",
): StoreMutationInput {
	return {
		userId,
		tier: "anonymous",
		ipKey,
		...(requestId === undefined ? {} : { requestId }),
		method: "thread",
		roomId: "general",
		now: clock.value,
		thread,
		params: { room_id: "general" },
		identity: { user_id: userId, name: "Alice" },
	};
}

function nextMinute(clock: TestClock): void {
	clock.value += 61_000;
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

it("keeps log IDs strictly increasing across equal and backward clocks", async () => {
	await withStore("sequence", (store, clock) => {
		const first = store.mutate(messageInput(clock, "alice", "s1", { body: { format: "plain", text: "one" } }));
		const firstLog = Number(first.transition?.log_id);
		clock.value = clock.value;
		const second = store.mutate(messageInput(clock, "alice", "s2", { body: { format: "plain", text: "two" } }));
		const secondLog = Number(second.transition?.log_id);
		clock.value -= 10_000;
		const third = store.mutate(messageInput(clock, "alice", "s3", { body: { format: "plain", text: "three" } }));
		const thirdLog = Number(third.transition?.log_id);

		expect(firstLog).toBeGreaterThan(0);
		expect(secondLog).toBeGreaterThan(firstLog);
		expect(thirdLog).toBeGreaterThan(secondLog);
		expect(store.getRoomState().latest_log_id).toBe(String(thirdLog));
	});
});

it("enforces ownership and replacement semantics for edit, delete, and restore", async () => {
	await withStore("edits", (store, clock) => {
		const created = store.mutate(messageInput(clock, "alice", "m1", {
			body: { format: "plain", text: "original" },
			extension: { keep: true },
		}));
		const messageId = created.result.message_id;
		expect(typeof messageId).toBe("string");

		nextMinute(clock);
		const edited = store.mutate(messageInput(clock, "alice", "m2", {
			message_id: messageId,
			body: { format: "plain", text: "replacement" },
		}));
		expect(edited.transition?.message.message_id).toBe(messageId);
		expect(edited.transition?.message.from.user_id).toBe("alice");
		expect(edited.transition?.message.extension).toBeUndefined();
		expect(edited.transition?.message.body?.text).toBe("replacement");

		nextMinute(clock);
		expect(errorCode(() => store.mutate(messageInput(clock, "bob", "spoof", {
			message_id: messageId,
			body: { format: "plain", text: "spoofed" },
		})))).toBe("denied");

		nextMinute(clock);
		const deleted = store.mutate(messageInput(clock, "alice", "m3", { message_id: messageId, deleted: true }));
		expect(deleted.transition?.message.deleted).toBe(true);
		expect(deleted.transition?.message.body).toBeUndefined();

		nextMinute(clock);
		const restored = store.mutate(messageInput(clock, "alice", "m4", {
			message_id: messageId,
			deleted: false,
			body: { format: "plain", text: "restored" },
		}));
		expect(restored.transition?.message.deleted).toBeUndefined();
		expect(restored.transition?.message.body?.text).toBe("restored");
	});
});

it("validates replies and preserves thread arrival/departure in filtered history", async () => {
	await withStore("threads", (store, clock) => {
		const root = store.mutate(messageInput(clock, "alice", "root", { body: { format: "plain", text: "root" } }));
		const rootId = String(root.result.message_id);

		nextMinute(clock);
		expect(errorCode(() => store.mutate(messageInput(clock, "alice", "bad-reply", {
			body: { format: "plain", text: "bad" },
			reply_message_id: "missing-message",
		})))).toBe("invalid_params");

		nextMinute(clock);
		const createdThread = store.mutateThread(threadInput(clock, "alice", "thread-1", {
			title: "First",
			rootMessageId: rootId,
		}));
		const firstThreadId = String(createdThread.result.thread_id);
		expect(firstThreadId).toMatch(/^t_/);
		expect(createdThread.thread?.root_message_id).toBe(rootId);

		nextMinute(clock);
		const reply = store.mutate(messageInput(clock, "alice", "reply", {
			body: { format: "plain", text: "in first thread" },
			thread_id: firstThreadId,
			reply_message_id: rootId,
		}));
		const replyId = String(reply.result.message_id);
		expect(reply.transition?.previous_thread_id).toBeUndefined();
		expect(reply.transition?.thread_id).toBe(firstThreadId);

		nextMinute(clock);
		const editedThread = store.mutateThread(threadInput(clock, "alice", "thread-edit", {
			threadId: firstThreadId,
			title: "Renamed",
			summary: "Updated summary",
		}));
		expect(editedThread.thread?.title).toBe("Renamed");
		expect(store.getThreads().find((thread) => thread.thread_id === firstThreadId)?.summary).toBe("Updated summary");

		nextMinute(clock);
		const secondThread = store.mutateThread(threadInput(clock, "alice", "thread-2", { title: "Second" }));
		const secondThreadId = String(secondThread.result.thread_id);

		nextMinute(clock);
		const moved = store.mutate(messageInput(clock, "alice", "move", {
			message_id: replyId,
			body: { format: "plain", text: "moved" },
			thread_id: secondThreadId,
		}));
		expect(moved.transition?.previous_thread_id).toBe(firstThreadId);
		expect(moved.transition?.thread_id).toBe(secondThreadId);
		expect(moved.transition?.message.thread_id).toBe(secondThreadId);

		const firstHistory = store.history({
			roomId: "general",
			threadId: firstThreadId,
			limit: 50,
			maxBytes: 256 * 1024,
			now: clock.value,
			userId: "alice",
			ipKey: "ip-test",
		});
		const secondHistory = store.history({
			roomId: "general",
			threadId: secondThreadId,
			limit: 50,
			maxBytes: 256 * 1024,
			now: clock.value,
			userId: "alice",
			ipKey: "ip-test",
		});
		expect(firstHistory.entries.map((entry) => entry.message.message_id)).toContain(replyId);
		expect(firstHistory.entries.at(-1)?.message.thread_id).toBe(secondThreadId);
		expect(secondHistory.entries.map((entry) => entry.message.message_id)).toContain(replyId);
		expect(secondHistory.entries.at(-1)?.message.thread_id).toBe(secondThreadId);
	});
});

it("keeps a recently edited message after its creation transition expires", async () => {
	await withStore("retention", (store, clock) => {
		const created = store.mutate(messageInput(clock, "alice", "old-create", { body: { format: "plain", text: "old" } }));
		const messageId = created.result.message_id;
		const creationLog = created.transition?.log_id;

		clock.value += 23 * 60 * 60 * 1_000;
		const edited = store.mutate(messageInput(clock, "alice", "recent-edit", {
			message_id: messageId,
			body: { format: "plain", text: "recent edit" },
		}));
		const editLog = String(edited.transition?.log_id);
		expect(Number(editLog)).toBeGreaterThan(Number(creationLog));

		clock.value += 2 * 60 * 60 * 1_000;
		const cleanup = store.runCleanup(clock.value);
		expect(cleanup.history_floor).toBe(String(Number(creationLog) + 1));
		const history = store.history({ roomId: "general", after: 0n, limit: 50, maxBytes: 256 * 1024, now: clock.value });
		expect(history.history_log_id).toBe(String(Number(creationLog) + 1));
		expect(history.entries.map((entry) => entry.log_id)).toEqual([editLog]);
		expect((history.entries[0].message.body as Record<string, unknown> | undefined)?.text).toBe("recent edit");
	});
});

it("deduplicates canonical retries before quotas, survives restart, and expires independently", async () => {
	await withStore("dedup", async (store, clock, state) => {
		const config = { anonymousPostsPerMinute: 1 };
		const limited = new Store(state, config, clock.clock);
		// Reuse the already-created native SQLite binding with a fresh Store
		// instance so this also exercises constructor/restart state without
		// relying on an in-memory fake database.
		limited.initialize();
		const params = { body: { format: "plain", text: "once", extension: { z: 1, a: 2 } } };
		const first = limited.mutate(messageInput(clock, "alice", "same", params));
		const restarted = new Store(state, config, clock.clock);
		restarted.initialize();
		const retry = restarted.mutate(messageInput(clock, "alice", "same", {
			body: { extension: { a: 2, z: 1 }, text: "once", format: "plain" },
		}));
		expect(retry.deduplicated).toBe(true);
		expect(retry.result).toEqual(first.result);
		expect(errorCode(() => restarted.mutate(messageInput(clock, "alice", "same", {
			body: { format: "plain", text: "different" },
		})))).toBe("invalid_params");
		expect(errorCode(() => restarted.mutate(messageInput(clock, "alice", "new-request", {
			body: { format: "plain", text: "blocked" },
		})))).toBe("retry_after");

		clock.value += RETENTION_MS + 1;
		const afterExpiry = restarted.mutate(messageInput(clock, "alice", "same", params));
		expect(afterExpiry.deduplicated).not.toBe(true);
		expect(afterExpiry.result.message_id).not.toBe(first.result.message_id);
	});
});
