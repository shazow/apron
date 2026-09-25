import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { ChatClient, DEFAULT_ROOM_ID, type RoomSnapshot } from '../../clients/web/src/lib/protocol/client';

type ObjectValue = Record<string, unknown>;
type Step =
	| { receive: ObjectValue }
	| { request: { as: string; match: ObjectValue } }
	| { reply: { to: string; result?: ObjectValue; error?: ObjectValue } }
	| { send: { as: string; room?: string; text: string; format: 'plain' | 'markdown'; reply_to?: string; mentions?: string[] } }
	| { command: { as: string; room?: string; text: string; mentions?: string[] } }
	| { editMessage: { as: string; message_id: string; text: string } }
	| { moveMessage: { as: string; message_id: string; room: string } }
	| { deleteMessage: { as: string; message_id: string } }
	| { react: { as: string; message_id: string; emojis: string[] } }
	| { createRoom: { as: string; parent_room_id?: string; title?: string; intro_message_id?: string } }
	| { updateRoom: { as: string; room: string; title?: string | null; intro_message_id?: string | null } }
	| { joinRoom: { as: string; room: string } }
	| { leaveRoom: { as: string; room: string } }
	| { listRooms: { as: string; parent_room_id?: string } }
	| { loadRoom: { as: string; room: string } }
	| { loadOlder: { as: string; room: string } }
	| { disconnect: true }
	| { expect: ObjectValue };
interface Fixture {
	format: number;
	kind: string;
	name: string;
	variants: { name: string; steps: Step[] }[];
	expected: ObjectValue;
}

const MUTATIONS = new Set(['message', 'command', 'room_set', 'room_join', 'room_leave', 'reactions']);
const OPERATIONS = ['send', 'command', 'editMessage', 'moveMessage', 'deleteMessage', 'react', 'createRoom', 'updateRoom', 'joinRoom', 'leaveRoom', 'listRooms', 'loadRoom', 'loadOlder'];

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, '../..');
const fixtureDirectory = path.join(repository, 'tests/fixtures/wire/session');
const fixtures: Fixture[] = readdirSync(fixtureDirectory).filter((file) => file.endsWith('.json')).sort()
	.map((file) => JSON.parse(readFileSync(path.join(fixtureDirectory, file), 'utf8')));

let peer: ChildProcess;
let peerUrl: string;
let scratch: string;

test.beforeAll(async () => {
	test.setTimeout(60_000);
	mkdirSync(path.join(directory, 'test-results'), { recursive: true });
	scratch = mkdtempSync(path.join(directory, 'test-results/wire-peer-'));
	const executable = path.join(scratch, 'peer');
	execFileSync('go', ['build', '-o', executable, path.join(directory, 'wire-peer.go')], {
		cwd: path.join(repository, 'servers/go'), timeout: 30_000
	});
	peer = spawn(executable, [], { stdio: ['ignore', 'pipe', 'inherit'] });
	const lines = createInterface({ input: peer.stdout! });
	try {
		const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(5_000) });
		peerUrl = line;
	} finally {
		lines.close();
	}
});

test.afterAll(async () => {
	try {
		if (peer && peer.exitCode === null) {
			const exited = once(peer, 'exit', { signal: AbortSignal.timeout(5_000) });
			peer.kill('SIGTERM');
			await exited;
		}
	} finally {
		if (peer?.exitCode === null) peer.kill('SIGKILL');
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	}
});

async function control(route: string, body?: ObjectValue): Promise<Response> {
	const response = await fetch(`${peerUrl}${route}`, {
		method: route === '/next' ? 'GET' : 'POST',
		...(body ? { body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout(5_000)
	});
	expect(response.ok, `${route}: ${response.status}`).toBe(true);
	return response;
}

const byString = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** The room projection of tests/fixtures/wire/README.md, from the client's public snapshot. */
function projectRoom(room: RoomSnapshot): ObjectValue {
	const record = room.record;
	const has = (key: string) => record !== undefined && Object.hasOwn(record, key);
	return {
		room_id: room.id,
		...(has('log_id') ? { log_id: record!.log_id } : {}),
		...(has('parent_room_id') ? { parent_room_id: record!.parent_room_id } : {}),
		...(has('title') ? { title: record!.title } : {}),
		...(record?.intro_message ? { intro_message: { message_id: record.intro_message.message_id } } : {}),
		...(has('ext') ? { ext: record!.ext } : {}),
		messages: room.timeline.order.map((id) => {
			const reactions = room.timeline.reactions[id];
			return {
				...room.timeline.events[id],
				...(reactions ? { reactions: reactions.map(({ emoji, user_ids }) => ({ emoji, user_ids })) } : {})
			};
		})
	};
}

function logicalState(client: ChatClient, operations: Record<string, string>): ObjectValue {
	const snapshot = client.snapshot();
	// The default room before its `room_id` is known is the client's own placeholder, not a room.
	const rooms = snapshot.rooms.filter((room) => room.id !== DEFAULT_ROOM_ID);
	return JSON.parse(JSON.stringify({
		you: snapshot.you ?? null,
		caps: [...(snapshot.server?.caps ?? [])].sort(byString),
		rooms: [...rooms].sort((left, right) => byString(left.id, right.id)).map(projectRoom),
		typing: snapshot.typing
			.map((entry) => ({ room_id: entry.room, from: entry.from }))
			.sort((left, right) => byString(left.room_id, right.room_id) || byString(left.from.user_id, right.from.user_id)),
		users: Object.fromEntries(Object.keys(snapshot.users).sort(byString).map((id) => [id, snapshot.users[id]])),
		notices: snapshot.rooms.flatMap((room) => room.notices)
			.sort((left, right) => left.at - right.at || byString(left.key, right.key))
			.map(({ room_id, from, body }) => ({ room_id, from, ...(body ? { body } : {}) })),
		directory: (snapshot.directory ?? []).map((listing) => listing.id),
		operations
	}));
}

/** Only the given keys of the expected state (README "Session state"). */
function pick(state: ObjectValue, expected: ObjectValue): ObjectValue {
	return Object.fromEntries(Object.keys(expected).map((key) => [key, state[key]]));
}

/**
 * The recursive subset of `actual` described by `expected`: objects keep the
 * listed keys, arrays and scalars compare exactly.
 */
function restrict(actual: unknown, expected: unknown): unknown {
	if (!isObject(expected) || !isObject(actual)) return actual;
	const result: ObjectValue = {};
	for (const key of Object.keys(expected)) {
		if (Object.hasOwn(actual, key)) Object.defineProperty(result, key, { value: restrict(actual[key], expected[key]), enumerable: true, writable: true, configurable: true });
	}
	return result;
}

function isObject(value: unknown): value is ObjectValue {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function paramsOf(frame: ObjectValue): ObjectValue | undefined {
	return isObject(frame.params) ? frame.params : undefined;
}

for (const fixture of fixtures) {
	for (const variant of fixture.variants) {
		for (const envelope of ['minimal', 'jsonrpc'] as const) {
			test(`${fixture.name} / ${variant.name} / ${envelope}`, async () => {
				expect(fixture.format).toBe(3);
				expect(fixture.kind).toBe('session');
				const client = new ChatClient(peerUrl.replace('http:', 'ws:') + '/ws');
				const requests = new Map<string, ObjectValue>();
				const unmatched: ObjectValue[] = [];
				const operations: Record<string, string> = {};
				const wire = (frame: ObjectValue) => envelope === 'jsonrpc' ? { ...frame, jsonrpc: '2.0' } : frame;
				const track = (as: string, promise: Promise<unknown>) => {
					expect(Object.hasOwn(operations, as), `duplicate operation ${as}`).toBe(false);
					operations[as] = 'pending';
					promise.then(() => { operations[as] = 'fulfilled'; }, () => { operations[as] = 'rejected'; });
				};
				client.start();
				let connection: string;
				try {
					connection = await (await control('/next')).json();
					for (const [index, step] of variant.steps.entries()) {
						const kind = Object.keys(step)[0];
						await test.step(`step ${index + 1}: ${kind}`, async () => {
							expect(Object.keys(step)).toHaveLength(1);
							if ('receive' in step) {
								await control(`/connections/${connection}/send`, wire(structuredClone(step.receive)));
							} else if ('request' in step) {
								const { as, match } = step.request;
								expect(requests.has(as), `duplicate capture ${as}`).toBe(false);
								const wanted = isObject(match.params) ? match.params : {};
								const selects = (frame: ObjectValue) => frame.method === match.method &&
									paramsOf(frame)?.room_id === wanted.room_id &&
									paramsOf(frame)?.message_id === wanted.message_id;
								let position = unmatched.findIndex(selects);
								while (position < 0) {
									unmatched.push(await (await control(`/connections/${connection}/receive`)).json());
									position = unmatched.findIndex(selects);
								}
								const [frame] = unmatched.splice(position, 1);
								expect(restrict(frame, match)).toEqual(match);
								if (MUTATIONS.has(match.method as string)) expect(frame.params).toEqual(match.params);
								if ('jsonrpc' in frame) expect(frame.jsonrpc).toBe('2.0');
								expect(typeof frame.id).toBe('string');
								expect([...requests.values()].some((previous) => previous.id === frame.id), 'new operation reuses a request ID').toBe(false);
								requests.set(as, frame);
							} else if ('reply' in step) {
								const request = requests.get(step.reply.to);
								expect(request, `uncaptured request ${step.reply.to}`).toBeDefined();
								const { to: _, ...result } = step.reply;
								await control(`/connections/${connection}/send`, wire({ id: request!.id, ...result }));
							} else if ('send' in step) {
								const { as, room, text, format, reply_to, mentions } = step.send;
								track(as, client.send(room ?? DEFAULT_ROOM_ID, text, format, {
									...(reply_to !== undefined ? { replyTo: reply_to } : {}),
									...(mentions !== undefined ? { mentions } : {})
								}).promise);
							} else if ('command' in step) {
								const { as, room, text, mentions } = step.command;
								track(as, client.command(room ?? DEFAULT_ROOM_ID, text, mentions !== undefined ? { mentions } : {}).promise);
							} else if ('editMessage' in step) {
								const { as, message_id, text } = step.editMessage;
								track(as, client.editMessage(message_id, text).promise);
							} else if ('moveMessage' in step) {
								const { as, message_id, room } = step.moveMessage;
								track(as, client.moveMessage(message_id, room).promise);
							} else if ('deleteMessage' in step) {
								const { as, message_id } = step.deleteMessage;
								track(as, client.deleteMessage(message_id).promise);
							} else if ('react' in step) {
								const { as, message_id, emojis } = step.react;
								track(as, client.react(message_id, emojis).promise);
							} else if ('createRoom' in step) {
								const { as, parent_room_id, title, intro_message_id } = step.createRoom;
								track(as, client.createRoom({
									...(parent_room_id !== undefined ? { parentRoomId: parent_room_id } : {}),
									...(title !== undefined ? { title } : {}),
									...(intro_message_id !== undefined ? { introMessageId: intro_message_id } : {})
								}).promise);
							} else if ('updateRoom' in step) {
								const { as, room, ...patch } = step.updateRoom;
								track(as, client.updateRoom(room, {
									...(Object.hasOwn(patch, 'title') ? { title: patch.title } : {}),
									...(Object.hasOwn(patch, 'intro_message_id') ? { introMessageId: patch.intro_message_id } : {})
								}).promise);
							} else if ('joinRoom' in step) {
								track(step.joinRoom.as, client.joinRoom(step.joinRoom.room).promise);
							} else if ('leaveRoom' in step) {
								track(step.leaveRoom.as, client.leaveRoom(step.leaveRoom.room).promise);
							} else if ('listRooms' in step) {
								track(step.listRooms.as, client.listRooms(step.listRooms.parent_room_id));
							} else if ('loadRoom' in step) {
								const { as, room } = step.loadRoom;
								track(as, client.loadRoom(room));
							} else if ('loadOlder' in step) {
								const { as, room } = step.loadOlder;
								track(as, client.loadOlder(room));
							} else if ('disconnect' in step) {
								await control(`/connections/${connection}/close`);
								unmatched.length = 0;
								connection = await (await control('/next')).json();
							} else if ('expect' in step) {
								await expect.poll(() => pick(logicalState(client, operations), step.expect)).toEqual(step.expect);
							} else {
								throw new Error(`Unknown fixture step: ${JSON.stringify(step)} (operations: ${OPERATIONS.join(', ')})`);
							}
						});
					}
					await expect.poll(() => pick(logicalState(client, operations), fixture.expected)).toEqual(fixture.expected);
				} finally {
					client.stop();
				}
			});
		}
	}
}
