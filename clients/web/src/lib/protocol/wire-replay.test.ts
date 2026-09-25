import { describe, expect, it } from 'vitest';
import { ProtocolStore, applyRecords, decodeHistoryRecords, type DecodedRecords } from './reducer';
import { decodeMessage, decodeNotice, decodeReactions, decodeRoom, type MessageRecord } from './types';

type WireRecord = Record<string, unknown>;
interface Projection { rooms: unknown[] }

interface ReplayStep {
	receive?: WireRecord;
	expect?: Projection;
}

interface ReplayVariant {
	name: string;
	steps: ReplayStep[];
}

interface ReplayFixture {
	format: number;
	kind: string;
	name: string;
	description: string;
	references: string[];
	variants: ReplayVariant[];
	expected: Projection;
}

const fixtureModules = import.meta.glob('../../../../../tests/fixtures/wire/replay/*.json', {
	eager: true,
	query: '?raw',
	import: 'default'
}) as Record<string, string>;
const fixtures = Object.entries(fixtureModules)
	.sort(([left], [right]) => left.localeCompare(right))
	.map(([file, source]) => [file, readFixture(source)] as const);

if (!fixtures.length) throw new Error('No replay fixtures found');

describe('wire replay fixtures', () => {
	for (const [fixtureFile, fixture] of fixtures) {
		it(`${fixtureFile} reduces every variant with both envelopes`, () => {
			expect(fixture.format).toBe(3);
			expect(fixture.kind).toBe('replay');
			expect(Object.keys(fixture).sort()).toEqual(['description', 'expected', 'format', 'kind', 'name', 'references', 'variants']);
			expect(fixture.variants.length).toBeGreaterThan(0);

			for (const variant of fixture.variants) {
				for (const envelope of ['minimal', 'jsonrpc'] as const) {
					const actual = runVariant(variant, envelope === 'jsonrpc');
					expect(actual, `${fixtureFile}/${variant.name}/${envelope}`).toStrictEqual(normalizeJson(fixture.expected));
				}
			}
		});
	}
});

function readFixture(source: string): ReplayFixture {
	const value = JSON.parse(source) as ReplayFixture;
	if (!value || value.kind !== 'replay' || !Array.isArray(value.variants)) {
		throw new Error('Invalid replay fixture');
	}
	return value;
}

function runVariant(variant: ReplayVariant, useJsonRpc: boolean): Projection {
	const store = new ProtocolStore();
	for (const [index, step] of variant.steps.entries()) {
		const keys = Object.keys(step);
		if (keys.length !== 1 || !['receive', 'expect'].includes(keys[0])) {
			throw new Error(`Invalid replay step: ${JSON.stringify(step)}`);
		}
		if (step.receive !== undefined) {
			const frame = useJsonRpc ? withJsonRpc(step.receive) : step.receive;
			applyFrame(store, frame);
		}
		if (step.expect !== undefined) {
			expect(project(store), `${variant.name}/step-${index}`).toStrictEqual(normalizeJson(step.expect));
		}
	}
	return project(store);
}

/** The fixture adapter: a frame's records into the store (README "Decoding"). */
function applyFrame(store: ProtocolStore, frame: WireRecord): void {
	if (frame.method === 'message') {
		const decoded = decodeMessage(frame.params);
		if (decoded) {
			applyRecords(store, { rooms: [], messages: [decoded.record], reactions: [], embedded: decoded.embedded });
			return;
		}
		// A transient notice is rendered, never installed (§3.5).
		if (decodeNotice(frame.params)) return;
		throw new Error(`Invalid message snapshot: ${JSON.stringify(frame)}`);
	}
	if (frame.method === 'room_update') {
		const params = (frame.params ?? {}) as WireRecord;
		applyRecords(store, roomRecords([...array(params.joined), ...array(params.updated)]));
		return;
	}
	if (frame.method === 'reactions') {
		const sets = decodeReactions(frame.params);
		if (!sets.length) throw new Error(`Invalid reactions record: ${JSON.stringify(frame)}`);
		applyRecords(store, { rooms: [], messages: [], reactions: sets, embedded: [] });
		return;
	}
	if (frame.method === undefined && Object.hasOwn(frame, 'result')) {
		if (typeof frame.id !== 'string' || frame.id.length === 0) {
			throw new Error('a result must have a fixed string request ID');
		}
		const result = frame.result as WireRecord;
		if (Array.isArray(result?.entries)) {
			applyRecords(store, decodeHistoryRecords(result));
			return;
		}
		if (Array.isArray(result?.joined) || Array.isArray(result?.rooms)) {
			applyRecords(store, roomRecords([...array(result.joined), ...array(result.rooms)]));
			return;
		}
		throw new Error('a result must be a history page (entries) or a room_list (joined, rooms)');
	}
	throw new Error(`Unsupported replay fixture frame: ${JSON.stringify(frame)}`);
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** Room records from `room_list` or `room_update`, with their embedded snapshots; delivery fields are not records. */
function roomRecords(values: unknown[]): DecodedRecords {
	const decoded: DecodedRecords = { rooms: [], messages: [], reactions: [], embedded: [] };
	for (const value of values) {
		const room = decodeRoom(value);
		if (!room) throw new Error(`Invalid room record: ${JSON.stringify(value)}`);
		decoded.rooms.push(room.record);
		decoded.embedded.push(...room.embedded);
	}
	return decoded;
}

/** The logical projection of README "Room projection" / "Message projection". */
function project(store: ProtocolStore): Projection {
	const rooms = store.roomIds().sort(compareStrings).map((roomId) => {
		const record = store.room(roomId);
		return {
			room_id: roomId,
			...(record && Object.hasOwn(record, 'log_id') ? { log_id: record.log_id } : {}),
			...(record && Object.hasOwn(record, 'parent_room_id') ? { parent_room_id: record.parent_room_id } : {}),
			...(record && Object.hasOwn(record, 'title') ? { title: record.title } : {}),
			...(record?.intro_message ? { intro_message: { message_id: record.intro_message.message_id } } : {}),
			...(record && Object.hasOwn(record, 'ext') ? { ext: record.ext } : {}),
			messages: store.messagesIn(roomId).map((message) => projectMessage(message, store))
		};
	});
	return normalizeJson({ rooms });
}

function projectMessage(message: MessageRecord, store: ProtocolStore): unknown {
	const reactions = store.reactions(message.message_id);
	return {
		...message,
		...(reactions ? { reactions: reactions.map(({ emoji, user_ids }) => ({ emoji, user_ids })) } : {})
	};
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function withJsonRpc(frame: WireRecord): WireRecord {
	const copy = JSON.parse(JSON.stringify(frame)) as WireRecord;
	copy.jsonrpc = '2.0';
	return copy;
}

/** Convert null-prototype store objects to plain logical wire JSON for comparison. */
function normalizeJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
