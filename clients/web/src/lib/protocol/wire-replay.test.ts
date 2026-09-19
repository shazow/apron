import { describe, expect, it } from 'vitest';
import { applyTransitions, createTimeline, timelineEvents } from './reducer';
import { toTransition, type Transition } from './types';

type WireRecord = Record<string, unknown>;

interface ReplayStep {
	receive?: WireRecord;
	expect?: { events: unknown[] };
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
	room: string;
	variants: ReplayVariant[];
	expected: { events: unknown[] };
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
			expect(fixture.format).toBe(1);
			expect(fixture.kind).toBe('replay');
			expect(typeof fixture.room).toBe('string');
			expect(fixture.variants.length).toBeGreaterThan(0);

			for (const variant of fixture.variants) {
				for (const envelope of ['minimal', 'jsonrpc'] as const) {
					const actual = runVariant(fixture, variant, envelope === 'jsonrpc');
					expect(actual, `${fixtureFile}/${variant.name}/${envelope}`).toStrictEqual(
						normalizeJson(fixture.expected.events)
					);
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

function runVariant(fixture: ReplayFixture, variant: ReplayVariant, useJsonRpc: boolean): unknown[] {
	let state = createTimeline(fixture.room);
	for (const [index, step] of variant.steps.entries()) {
		const keys = Object.keys(step);
		if (keys.length !== 1 || !['receive', 'expect'].includes(keys[0])) {
			throw new Error(`Invalid replay step: ${JSON.stringify(step)}`);
		}
		if (step.receive !== undefined) {
			const frame = useJsonRpc ? withJsonRpc(step.receive) : step.receive;
			state = applyTransitions(state, decodeFrame(frame, fixture.room));
		}
		if (step.expect !== undefined) {
			expect(normalizeJson(timelineEvents(state)), `${variant.name}/step-${index}`).toStrictEqual(
				normalizeJson(step.expect.events)
			);
		}
	}
	return normalizeJson(timelineEvents(state));
}

function decodeFrame(frame: WireRecord, room: string): Transition[] {
	if (frame.method === 'message') {
		const params = requireRecord(frame.params, 'message.params');
		requireRoom(params, room, 'message.params.room_id');
		return [requireTransition(params, 'message.params')];
	}

	if (frame.method === undefined && Object.prototype.hasOwnProperty.call(frame, 'result')) {
		if (typeof frame.id !== 'string' || frame.id.length === 0) {
			throw new Error('history result must have a fixed string request ID');
		}
		const result = requireRecord(frame.result, 'history.result');
		if (!Array.isArray(result.entries)) throw new Error('history.result.entries must be an array');
		return result.entries.map((entry, index) => requireTransition(entry, `history.result.entries[${index}]`));
	}

	throw new Error(`Unsupported replay fixture frame: ${JSON.stringify(frame)}`);
}

function requireTransition(value: unknown, label: string): Transition {
	const transition = toTransition(value);
	if (!transition) throw new Error(`${label} is not a valid message snapshot`);
	return transition;
}

function requireRecord(value: unknown, label: string): WireRecord {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return value;
}

function requireRoom(record: WireRecord, room: string, label: string): void {
	if (record.room_id !== room) throw new Error(`${label} must be ${room}`);
}

function isRecord(value: unknown): value is WireRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withJsonRpc(frame: WireRecord): WireRecord {
	const copy = JSON.parse(JSON.stringify(frame)) as WireRecord;
	copy.jsonrpc = '2.0';
	return copy;
}

/** Convert reducer null-prototype maps to plain logical wire JSON for comparison. */
function normalizeJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
