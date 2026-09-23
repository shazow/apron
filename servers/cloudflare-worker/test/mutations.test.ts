import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { RETENTION_MS, Store, StoreError, type StoreConfig, type StoreMutationInput, type StoreMutationResult } from "../src/store";

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

// Semantics tests use roomy posting windows; quota tests below use tiny ones.
const ROOMY: Partial<StoreConfig> = {
	anonymousPostsPerMinute: 1_000,
	anonymousPostsPerDay: 1_000,
	ipPostsPerMinute: 1_000,
	ipPostsPerDay: 1_000,
	globalPostsPerMinute: 1_000,
	globalPostsPerDay: 5_000,
};

async function withStore<T>(
	name: string,
	fn: (store: Store, clock: TestClock, state: DurableObjectState) => T | Promise<T>,
	config: Partial<StoreConfig> = ROOMY,
): Promise<T> {
	const stub = env.DEMO.getByName(`mutation-${name}-${crypto.randomUUID()}`);
	return runInDurableObject(stub, async (_instance, state) => {
		const clock = makeClock();
		const store = new Store(state, config, clock.clock);
		store.initialize();
		return fn(store, clock, state);
	});
}

function op(
	clock: TestClock,
	userId: string,
	requestId: string | undefined,
	method: string,
	params: Record<string, unknown>,
	ipKey = "ip-test",
): StoreMutationInput {
	return {
		userId,
		tier: "anonymous",
		ipKey,
		...(requestId === undefined ? {} : { requestId }),
		method,
		now: clock.value,
		params,
		identity: { user_id: userId, name: userId === "alice" ? "Alice" : "Bob" },
	};
}

const post = (store: Store, clock: TestClock, userId: string, requestId: string | undefined, params: Record<string, unknown>) =>
	store.mutate(op(clock, userId, requestId, "message", { room_id: "general", ...params }));

function errorCode(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		if (error instanceof StoreError) return error.code;
		throw error;
	}
	throw new Error("expected StoreError");
}

function logOf(result: StoreMutationResult): number {
	const logId = result.broadcasts[0]?.params.log_id;
	if (typeof logId !== "string") throw new Error("mutation produced no record");
	return Number(logId);
}

function thread(store: Store, clock: TestClock, requestId: string, params: Record<string, unknown> = {}, userId = "alice"): string {
	const created = store.mutate(op(clock, userId, requestId, "room", { parent_room_id: "general", title: "Thread", ...params }));
	return String(created.result.room_id);
}

it("allocates one strictly increasing log sequence across rooms, record kinds, and clocks", async () => {
	await withStore("sequence", (store, clock) => {
		const general = store.getRoomState();
		const first = post(store, clock, "alice", "s1", { body: { text: "one" } });
		expect(first.message?.message_id).toBe(first.message?.log_id);
		const roomResult = store.mutate(op(clock, "alice", "s2", "room", { parent_room_id: "general", title: "Side" }));
		const threadId = String(roomResult.result.room_id);
		// Suggested convention: a room's ID is its creation log_id.
		expect(roomResult.room?.log_id).toBe(threadId);
		const inThread = store.mutate(op(clock, "alice", "s3", "message", { room_id: threadId, body: { text: "two" } }));
		const reacted = store.mutate(op(clock, "bob", "s4", "reactions", { message_id: first.result.message_id, emojis: ["👍"] }));
		clock.value -= 10_000;
		const backward = post(store, clock, "alice", "s5", { body: { text: "three" } });

		const logs = [Number(general.log_id), logOf(first), logOf(roomResult), logOf(inThread), logOf(reacted), logOf(backward)];
		for (let index = 1; index < logs.length; index += 1) expect(logs[index]).toBeGreaterThan(logs[index - 1]);
		expect(store.logBounds().latest_log_id).toBe(String(logs.at(-1)));
		expect(store.getRoomState().latest_log_id).toBe(String(logs.at(-1)));
		expect(store.getRoomState(threadId).latest_log_id).toBe(String(logOf(inThread)));
		// Message IDs are globally unique: equal to the creation log_id.
		expect(inThread.message?.message_id).toBe(String(logOf(inThread)));
	});
});

it("broadcasts flat self-describing snapshots and enforces replacement semantics", async () => {
	await withStore("edits", (store, clock) => {
		const created = post(store, clock, "alice", "m1", {
			body: { text: "original" },
			ext: { irc: { nick: "ada_" } },
			unknown_top_level: "dropped",
		});
		const messageId = String(created.result.message_id);
		expect(created.broadcasts).toHaveLength(1);
		expect(created.broadcasts[0]).toEqual({
			method: "message",
			params: {
				message_id: messageId, log_id: messageId, room_id: "general",
				from: { user_id: "alice", name: "Alice" },
				body: { text: "original", format: "plain", embeds: [] },
				ext: { irc: { nick: "ada_" } },
			},
		});

		const edited = post(store, clock, "alice", "m2", { message_id: messageId, body: { text: "replacement", format: "markdown" } });
		expect(edited.message).toMatchObject({ message_id: messageId, room_id: "general", from: { user_id: "alice" } });
		expect(Number(edited.message?.log_id)).toBeGreaterThan(Number(messageId));
		expect(edited.message?.ext).toBeUndefined();
		expect(edited.message?.body).toEqual({ text: "replacement", format: "markdown", embeds: [] });

		expect(errorCode(() => post(store, clock, "bob", "spoof", { message_id: messageId, body: { text: "spoofed" } }))).toBe("denied");
		expect(errorCode(() => post(store, clock, "alice", "missing", { message_id: "999", body: { text: "x" } }))).toBe("invalid_params");
		expect(errorCode(() => post(store, clock, "alice", "no-body", { message_id: messageId }))).toBe("invalid_params");
		expect(errorCode(() => post(store, clock, "alice", "born-deleted", { deleted: true }))).toBe("invalid_params");
		expect(errorCode(() => post(store, clock, "alice", "log-id", { body: { text: "x" }, log_id: "1" }))).toBe("invalid_params");
		expect(errorCode(() => post(store, clock, "alice", "bad-ext", { body: { text: "x" }, ext: ["not", "object"] }))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "alice", "no-room", "message", { body: { text: "x" } })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "alice", "bad-room", "message", { room_id: "private", body: { text: "x" } })))).toBe("invalid_params");

		const deleted = post(store, clock, "alice", "m3", { message_id: messageId, deleted: true, body: { text: "ignored" }, ext: { keep: true } });
		expect(deleted.message?.deleted).toBe(true);
		expect(deleted.message?.body).toBeUndefined();
		expect(deleted.message?.ext).toEqual({ keep: true });

		const restored = post(store, clock, "alice", "m4", { message_id: messageId, deleted: false, body: { text: "restored" } });
		expect(restored.message?.deleted).toBeUndefined();
		expect(restored.message?.body?.text).toBe("restored");
	});
});

it("validates bare reply_to references across rooms", async () => {
	await withStore("replies", (store, clock) => {
		const root = post(store, clock, "alice", "root", { body: { text: "root" } });
		const rootId = String(root.result.message_id);
		const threadId = thread(store, clock, "thread", { intro_message: { message_id: rootId } });

		expect(errorCode(() => post(store, clock, "alice", "bad-reply", { body: { text: "bad" }, reply_to: { message_id: "404" } }))).toBe("invalid_params");
		expect(errorCode(() => post(store, clock, "alice", "bare-string", { body: { text: "bad" }, reply_to: rootId }))).toBe("invalid_params");
		expect(errorCode(() => post(store, clock, "alice", "self", { message_id: rootId, body: { text: "self" }, reply_to: { message_id: rootId } }))).toBe("invalid_params");

		// The target may live in another room; the server keeps only the ID.
		const reply = store.mutate(op(clock, "bob", "reply", "message", {
			room_id: threadId,
			body: { text: "in thread" },
			reply_to: { message_id: rootId, body: { text: "client copy" } },
		}));
		expect(reply.message?.reply_to).toEqual({ message_id: rootId });
		expect(reply.message?.room_id).toBe(threadId);

		// Saves replace every client field: omitting reply_to removes it.
		const cleared = store.mutate(op(clock, "bob", "clear-reply", "message", {
			message_id: reply.result.message_id, room_id: threadId, body: { text: "no reply" },
		}));
		expect(cleared.message?.reply_to).toBeUndefined();
	});
});

it("keeps an unchanged reply reference editable after its target expires", async () => {
	await withStore("reply-expiry", (store, clock) => {
		const target = post(store, clock, "alice", "target", { body: { text: "old target" } });
		const targetId = String(target.result.message_id);
		clock.value += 60 * 60 * 1_000;
		const reply = post(store, clock, "alice", "reply", { body: { text: "reply" }, reply_to: { message_id: targetId } });
		clock.value += RETENTION_MS - 30 * 60 * 1_000;
		store.runCleanup(clock.value);
		expect(errorCode(() => post(store, clock, "alice", "new-reply", { body: { text: "late" }, reply_to: { message_id: targetId } }))).toBe("invalid_params");
		const edited = post(store, clock, "alice", "edit", { message_id: reply.result.message_id, body: { text: "edited" }, reply_to: { message_id: targetId } });
		expect(edited.message?.reply_to).toEqual({ message_id: targetId });
	});
});

it("creates only thread rooms and replaces their client fields on save", async () => {
	await withStore("rooms", (store, clock) => {
		const intro = post(store, clock, "alice", "intro", { body: { text: "Deploy chatter" } });
		const introId = String(intro.result.message_id);

		expect(errorCode(() => store.mutate(op(clock, "alice", "top", "room", { title: "Top level" })))).toBe("denied");
		expect(errorCode(() => store.mutate(op(clock, "alice", "orphan", "room", { parent_room_id: "missing", title: "x" })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "alice", "bad-title", "room", { parent_room_id: "general", title: 7 })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "alice", "bad-intro", "room", { parent_room_id: "general", intro_message: { message_id: "404" } })))).toBe("invalid_params");

		const created = store.mutate(op(clock, "bob", "create", "room", {
			parent_room_id: "general", title: "Deploy", intro_message: { message_id: introId }, ext: { demo: { color: "blue" } },
		}));
		const roomId = String(created.result.room_id);
		expect(created.broadcasts).toHaveLength(1);
		expect(created.broadcasts[0].method).toBe("room");
		expect(created.room).toEqual({
			room_id: roomId, log_id: roomId, parent_room_id: "general", title: "Deploy",
			intro_message: intro.message,
			ext: { demo: { color: "blue" } },
			latest_log_id: roomId, history_log_id: roomId,
		});
		expect(errorCode(() => store.mutate(op(clock, "alice", "nested", "room", { parent_room_id: roomId, title: "Nested" })))).toBe("denied");

		// Any participant may save a thread's metadata; omitted fields are
		// cleared, the server supplies a title, and parent_room_id is fixed.
		const saved = store.mutate(op(clock, "alice", "save", "room", { room_id: roomId, parent_room_id: "elsewhere" }));
		expect(saved.result).toEqual({ room_id: roomId });
		expect(saved.room).toMatchObject({ room_id: roomId, parent_room_id: "general", title: "Thread" });
		expect(saved.room?.intro_message).toBeUndefined();
		expect(saved.room?.ext).toBeUndefined();
		expect(Number(saved.room?.log_id)).toBeGreaterThan(Number(roomId));
		expect(saved.room?.latest_log_id).toBe(saved.room?.log_id);
		expect(saved.room?.history_log_id).toBe(roomId);

		expect(errorCode(() => store.mutate(op(clock, "alice", "general", "room", { room_id: "general", title: "Renamed" })))).toBe("denied");
		expect(errorCode(() => store.mutate(op(clock, "alice", "unknown", "room", { room_id: "404", title: "x" })))).toBe("invalid_params");

		// Room records are logged in their own room.
		const history = store.historyPage({ roomId, after: "0", limit: 50, now: clock.value });
		expect(history.rooms?.map((room) => room.log_id)).toEqual([roomId, saved.room?.log_id]);
		expect(history.rooms?.[0]).toMatchObject({ title: "Deploy", intro_message: { message_id: introId } });
		expect(history.entries).toEqual([]);
		expect(store.listRooms().map((room) => room.room_id)).toEqual(["general", roomId]);
	});
});

it("denies thread creation beyond the thread ceiling", async () => {
	await withStore("thread-limit", (store, clock) => {
		thread(store, clock, "first");
		try {
			thread(store, clock, "second");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(StoreError);
			expect((error as StoreError).code).toBe("denied");
			expect((error as StoreError).message).toBe("thread_limit");
		}
	}, { ...ROOMY, maxThreads: 1 });
});

it("moves a message into both rooms' logs and re-logs its reactions in the destination", async () => {
	await withStore("moves", (store, clock) => {
		const original = post(store, clock, "alice", "original", { body: { text: "misplaced" } });
		const messageId = String(original.result.message_id);
		store.mutate(op(clock, "alice", "react-a", "reactions", { message_id: messageId, emojis: ["👍"] }));
		store.mutate(op(clock, "bob", "react-b", "reactions", { message_id: messageId, emojis: ["🎉", "👀"] }));
		const threadId = thread(store, clock, "thread");

		expect(errorCode(() => post(store, clock, "bob", "steal", { message_id: messageId, room_id: threadId, body: { text: "x" } }))).toBe("denied");
		expect(errorCode(() => post(store, clock, "alice", "nowhere", { message_id: messageId, room_id: "404", body: { text: "x" } }))).toBe("invalid_params");

		const moved = post(store, clock, "alice", "move", { message_id: messageId, room_id: threadId, body: { text: "moved" } });
		expect(moved.broadcasts.map((record) => record.method)).toEqual(["message", "reactions"]);
		const snapshot = moved.broadcasts[0].params;
		const reactions = moved.broadcasts[1].params;
		expect(snapshot).toMatchObject({ message_id: messageId, room_id: threadId });
		expect(Number(reactions.log_id)).toBeGreaterThan(Number(snapshot.log_id));
		expect(reactions).toMatchObject({ message_id: messageId, room_id: threadId });
		expect(reactions.reactions).toEqual([
			{ from: { user_id: "alice", name: "Alice" }, emojis: ["👍"] },
			{ from: { user_id: "bob", name: "Bob" }, emojis: ["🎉", "👀"] },
		]);

		// The move belongs to the source and destination logs; earlier history
		// of the message stays in the source room.
		const source = store.historyPage({ roomId: "general", after: "0", limit: 50, now: clock.value });
		expect(source.entries.map((entry) => [entry.log_id, entry.room_id])).toEqual([
			[messageId, "general"],
			[snapshot.log_id, threadId],
		]);
		expect(source.reactions?.map((record) => record.room_id)).toEqual(["general", "general"]);
		const destination = store.historyPage({ roomId: threadId, after: "0", limit: 50, now: clock.value });
		expect(destination.rooms?.map((room) => room.room_id)).toEqual([threadId]);
		expect(destination.entries.map((entry) => entry.log_id)).toEqual([snapshot.log_id]);
		expect(destination.reactions?.map((record) => record.log_id)).toEqual([reactions.log_id]);
		expect(store.getRoomState().latest_log_id).toBe(snapshot.log_id);
		expect(store.getRoomState(threadId).latest_log_id).toBe(reactions.log_id);

		// A later reaction is logged in the message's current room, and a move
		// without reactions logs only the snapshot.
		const later = store.mutate(op(clock, "bob", "react-later", "reactions", { message_id: messageId, emojis: [] }));
		expect(later.broadcasts[0].params.room_id).toBe(threadId);
		const plain = post(store, clock, "bob", "plain", { body: { text: "no reactions" } });
		const plainMove = post(store, clock, "bob", "plain-move", { message_id: plain.result.message_id, room_id: threadId, body: { text: "moved" } });
		expect(plainMove.broadcasts.map((record) => record.method)).toEqual(["message"]);
	});
});

it("sets, clears, collapses, and deduplicates reactions", async () => {
	await withStore("reactions", (store, clock) => {
		const target = post(store, clock, "alice", "target", { body: { text: "react to me" } });
		const messageId = String(target.result.message_id);

		const set = store.mutate(op(clock, "bob", "r1", "reactions", { message_id: messageId, emojis: ["👍", "🎉", "👍"] }));
		expect(set.result).toEqual({});
		expect(set.broadcasts).toEqual([{
			method: "reactions",
			params: {
				log_id: set.broadcasts[0].params.log_id, message_id: messageId, room_id: "general",
				reactions: [{ from: { user_id: "bob", name: "Bob" }, emojis: ["👍", "🎉"] }],
			},
		}]);

		const retry = store.mutate(op(clock, "bob", "r1", "reactions", { emojis: ["👍", "🎉", "👍"], message_id: messageId }));
		expect(retry.deduplicated).toBe(true);
		expect(retry.broadcasts).toEqual([]);
		expect(errorCode(() => store.mutate(op(clock, "bob", "r1", "reactions", { message_id: messageId, emojis: [] })))).toBe("invalid_params");

		// A reordered identical set is not a change and produces no record.
		const unchanged = store.mutate(op(clock, "bob", "r2", "reactions", { message_id: messageId, emojis: ["🎉", "👍"] }));
		expect(unchanged.result).toEqual({});
		expect(unchanged.broadcasts).toEqual([]);

		const cleared = store.mutate(op(clock, "bob", "r3", "reactions", { message_id: messageId, emojis: [] }));
		expect(cleared.broadcasts[0].params.reactions).toEqual([{ from: { user_id: "bob", name: "Bob" }, emojis: [] }]);
		expect(store.mutate(op(clock, "bob", "r4", "reactions", { message_id: messageId, emojis: [] })).broadcasts).toEqual([]);

		expect(errorCode(() => store.mutate(op(clock, "bob", "unknown", "reactions", { message_id: "404", emojis: ["👍"] })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "bob", "not-array", "reactions", { message_id: messageId, emojis: "👍" })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "bob", "not-string", "reactions", { message_id: messageId, emojis: [1] })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "bob", "empty", "reactions", { message_id: messageId, emojis: [""] })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "bob", "long", "reactions", { message_id: messageId, emojis: ["x".repeat(65)] })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "bob", "many", "reactions", {
			message_id: messageId, emojis: Array.from({ length: 9 }, (_, index) => `e${index}`),
		})))).toBe("invalid_params");

		const history = store.historyPage({ roomId: "general", after: target.message!.log_id, limit: 50, now: clock.value });
		expect(history.entries.map((entry) => entry.message_id)).toEqual([messageId]);
		expect(history.reactions?.map((record) => record.reactions[0].emojis)).toEqual([["👍", "🎉"], []]);
	});
});

it("rejects new reactions on tombstones and caps reacting users per message", async () => {
	await withStore("reaction-policy", (store, clock) => {
		const target = post(store, clock, "alice", "target", { body: { text: "popular" } });
		const messageId = String(target.result.message_id);
		store.mutate(op(clock, "alice", "a", "reactions", { message_id: messageId, emojis: ["👍"] }));
		store.mutate(op(clock, "bob", "b", "reactions", { message_id: messageId, emojis: ["👍"] }));
		expect(errorCode(() => store.mutate(op(clock, "carol", "c", "reactions", { message_id: messageId, emojis: ["👍"] })))).toBe("invalid_params");
		// Existing reactors may still change their own set.
		expect(store.mutate(op(clock, "bob", "b2", "reactions", { message_id: messageId, emojis: ["🎉"] })).broadcasts).toHaveLength(1);

		post(store, clock, "alice", "delete", { message_id: messageId, deleted: true });
		expect(errorCode(() => store.mutate(op(clock, "bob", "b3", "reactions", { message_id: messageId, emojis: ["👀"] })))).toBe("invalid_params");
		// Clearing a set on a tombstone is still allowed.
		expect(store.mutate(op(clock, "bob", "b4", "reactions", { message_id: messageId, emojis: [] })).broadcasts).toHaveLength(1);
	}, { ...ROOMY, reactionUsersPerMessage: 2 });
});

it("charges reactions and room changes against posting quotas and keeps accepted retries", async () => {
	await withStore("quota", (store, clock) => {
		const target = post(store, clock, "alice", "target", { body: { text: "one" } });
		const reaction = store.mutate(op(clock, "alice", "react", "reactions", { message_id: target.result.message_id, emojis: ["👍"] }));
		expect(reaction.broadcasts).toHaveLength(1);
		const created = store.mutate(op(clock, "alice", "room", "room", { parent_room_id: "general", title: "Quota" }));
		const limited = (fn: () => unknown) => {
			try { fn(); expect.unreachable(); }
			catch (error) { expect(error).toBeInstanceOf(StoreError); expect((error as StoreError).code).toBe("retry_after"); }
		};
		limited(() => store.mutate(op(clock, "alice", "react-2", "reactions", { message_id: target.result.message_id, emojis: [] })));
		limited(() => store.mutate(op(clock, "alice", "room-2", "room", { room_id: created.result.room_id, title: "Renamed" })));
		limited(() => post(store, clock, "alice", "post-2", { body: { text: "two" } }));
		// Accepted retries return their original result without a new charge.
		expect(store.mutate(op(clock, "alice", "room", "room", { parent_room_id: "general", title: "Quota" })).result).toEqual(created.result);
		expect(store.mutate(op(clock, "alice", "react", "reactions", { message_id: target.result.message_id, emojis: ["👍"] })).deduplicated).toBe(true);
		clock.value += 61_000;
		expect(store.mutate(op(clock, "alice", "react-3", "reactions", { message_id: target.result.message_id, emojis: [] })).broadcasts).toHaveLength(1);
	}, { anonymousPostsPerMinute: 3 });
});

it("keeps a recently edited message after its creation record expires", async () => {
	await withStore("retention", (store, clock) => {
		const created = post(store, clock, "alice", "old-create", { body: { text: "old" } });
		const messageId = created.result.message_id;
		const creationLog = logOf(created);

		clock.value += 23 * 60 * 60 * 1_000;
		const edited = post(store, clock, "alice", "recent-edit", { message_id: messageId, body: { text: "recent edit" } });
		const editLog = String(logOf(edited));

		clock.value += 2 * 60 * 60 * 1_000;
		const cleanup = store.runCleanup(clock.value);
		expect(cleanup.history_floor).toBe(String(creationLog + 1));
		const history = store.historyPage({ roomId: "general", after: "0", limit: 50, now: clock.value });
		expect(history.history_log_id).toBe(String(creationLog + 1));
		expect(history.rooms).toBeUndefined();
		expect(history.entries.map((entry) => entry.log_id)).toEqual([editLog]);
		expect(history.entries[0].body?.text).toBe("recent edit");
		// The general room record survives in the current-state table and is
		// still announced with its original log_id.
		expect(Number(store.getRoomState().log_id)).toBeLessThan(creationLog);
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
		const first = post(limited, clock, "alice", "same", params);
		const restarted = new Store(state, config, clock.clock);
		restarted.initialize();
		const retry = post(restarted, clock, "alice", "same", {
			body: { extension: { a: 2, z: 1 }, text: "once", format: "plain" },
		});
		expect(retry.deduplicated).toBe(true);
		expect(retry.broadcasts).toEqual([]);
		expect(retry.result).toEqual(first.result);
		expect(errorCode(() => post(restarted, clock, "alice", "same", { body: { format: "plain", text: "different" } }))).toBe("invalid_params");
		expect(errorCode(() => restarted.mutate(op(clock, "alice", "same", "reactions", params)))).toBe("invalid_params");
		expect(errorCode(() => post(restarted, clock, "alice", "new-request", { body: { format: "plain", text: "blocked" } }))).toBe("retry_after");

		clock.value += RETENTION_MS + 1;
		const afterExpiry = post(restarted, clock, "alice", "same", params);
		expect(afterExpiry.deduplicated).not.toBe(true);
		expect(afterExpiry.result.message_id).not.toBe(first.result.message_id);
	});
});
