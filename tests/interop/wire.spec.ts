import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { ChatClient } from '../../clients/web/src/lib/protocol/client';
import { timelineEvents } from '../../clients/web/src/lib/protocol/reducer';

type ObjectValue = Record<string, unknown>;
type Step =
	| { receive: ObjectValue; echoFrom?: string }
	| { request: { as: string; match: ObjectValue } }
	| { reply: { to: string; result?: ObjectValue; error?: ObjectValue } }
	| { send: { as: string; room: string; text: string; format?: 'plain' | 'markdown' } }
	| { disconnect: true }
	| { expect: ObjectValue };
interface Fixture {
	format: number;
	kind: string;
	name: string;
	variants: { name: string; steps: Step[] }[];
	expected: ObjectValue;
}

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

function logicalState(client: ChatClient, operations: Record<string, string>): ObjectValue {
	const snapshot = client.snapshot();
	return JSON.parse(JSON.stringify({
		you: snapshot.you ?? null,
		caps: [...(snapshot.server?.caps ?? [])].sort(),
		rooms: snapshot.rooms.map((room) => ({
			id: room.id, name: room.name, topic: room.topic ?? null, events: timelineEvents(room.timeline)
		})).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
		operations
	}));
}

for (const fixture of fixtures) {
	for (const variant of fixture.variants) {
		for (const envelope of ['minimal', 'jsonrpc'] as const) {
			test(`${fixture.name} / ${variant.name} / ${envelope}`, async () => {
				expect(fixture.format).toBe(1);
				expect(fixture.kind).toBe('session');
				const client = new ChatClient(peerUrl.replace('http:', 'ws:') + '/ws');
				const requests = new Map<string, ObjectValue>();
				const unmatched: ObjectValue[] = [];
				const operations: Record<string, string> = {};
				const wire = (frame: ObjectValue) => envelope === 'jsonrpc' ? { ...frame, jsonrpc: '2.0' } : frame;
				client.start();
				let connection: string;
				try {
					connection = await (await control('/next')).json();
					for (const [index, step] of variant.steps.entries()) {
						await test.step(`step ${index + 1}: ${Object.keys(step)[0]}`, async () => {
							if ('receive' in step) {
								const frame = structuredClone(step.receive);
								if (step.echoFrom) {
									const request = requests.get(step.echoFrom);
									expect(request, `uncaptured echo ${step.echoFrom}`).toBeDefined();
									(frame.params as ObjectValue).echo = request!.id;
								}
								await control(`/connections/${connection}/send`, wire(frame));
							} else if ('request' in step) {
								const { as, match } = step.request;
								expect(requests.has(as), `duplicate capture ${as}`).toBe(false);
								const requestRoom = (match.params as ObjectValue | undefined)?.room;
								const selects = (frame: ObjectValue) => frame.method === match.method &&
									(requestRoom === undefined || (frame.params as ObjectValue | undefined)?.room === requestRoom);
								let position = unmatched.findIndex(selects);
								while (position < 0) {
									unmatched.push(await (await control(`/connections/${connection}/receive`)).json());
									position = unmatched.findIndex(selects);
								}
								const [frame] = unmatched.splice(position, 1);
								expect(frame).toMatchObject(match);
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
								const { as, room, text, format } = step.send;
								operations[as] = 'pending';
								client.sendMessage(room, text, format).promise.then(
									() => { operations[as] = 'fulfilled'; },
									() => { operations[as] = 'rejected'; }
								);
							} else if ('disconnect' in step) {
								await control(`/connections/${connection}/close`);
								unmatched.length = 0;
								connection = await (await control('/next')).json();
							} else if ('expect' in step) {
								await expect.poll(() => logicalState(client, operations)).toEqual(expect.objectContaining(step.expect));
							} else {
								throw new Error(`Unknown fixture step: ${JSON.stringify(step)}`);
							}
						});
					}
					await expect.poll(() => logicalState(client, operations)).toEqual(expect.objectContaining(fixture.expected));
				} finally {
					client.stop();
				}
			});
		}
	}
}
