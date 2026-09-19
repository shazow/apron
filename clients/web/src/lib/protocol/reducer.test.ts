import { describe, expect, it } from 'vitest';
import { applyTransition, applyTransitions, createTimeline, mergePatch, timelineEvents } from './reducer';
import { toTransition, type EventRecord } from './types';

const creation = (event: Partial<EventRecord> & Pick<EventRecord, 'event_id'>): EventRecord => ({
	sender: { id: 'alice', name: 'Alice' },
	body: { text: 'original', format: 'plain', extra: 'kept' },
	...event,
	event_id: event.event_id
});

describe('timeline reducer', () => {
	it('applies merge patches, including null deletion, without changing creation ids', () => {
		let timeline = createTimeline('general');
		timeline = applyTransitions(timeline, [
			{ kind: 'creation', event: creation({ event_id: '100' }) },
			{
				kind: 'update',
				event_id: '101',
				target: '100',
				set: { body: { text: 'edited', extra: null }, custom: { flag: true } }
			}
		]);

		expect(timeline.events['100']).toEqual({
			event_id: '100',
			sender: { id: 'alice', name: 'Alice' },
			body: { text: 'edited', format: 'plain' },
			custom: { flag: true }
		});
		expect(timeline.events['100'].event_id).toBe('100');
	});

	it('installs raster replacements and replays updates that arrive before a creation', () => {
		let timeline = createTimeline('general');
		timeline = applyTransition(timeline, {
			kind: 'update',
			event_id: '300',
			target: '200',
			set: { body: { text: 'edited before load' } }
		});
		timeline = applyTransition(timeline, { kind: 'creation', event: creation({ event_id: '200' }) });
		expect(timeline.events['200'].body?.text).toBe('edited before load');

		timeline = applyTransition(timeline, {
			kind: 'update',
			event_id: '400',
			target: '999',
			replace: creation({ event_id: '999', body: { text: 'raster', format: 'markdown' } })
		});
		expect(timeline.events['999'].body?.text).toBe('raster');
	});

	it('keeps queued transitions newer than a raster snapshot', () => {
		let timeline = createTimeline('general');
		timeline = applyTransition(timeline, {
			kind: 'update',
			event_id: '300',
			target: '200',
			set: { body: { text: 'newer edit' } }
		});
		timeline = applyTransition(timeline, {
			kind: 'update',
			event_id: '250',
			target: '200',
			replace: creation({ event_id: '200', body: { text: 'state at 250', format: 'plain' } })
		});
		expect(timeline.events['200'].body?.text).toBe('newer edit');
	});

	it('deduplicates transition ids and orders creations numerically', () => {
		let timeline = createTimeline('general');
		timeline = applyTransitions(timeline, [
			{ kind: 'creation', event: creation({ event_id: '12', body: { text: 'second' } }) },
			{ kind: 'creation', event: creation({ event_id: '2', body: { text: 'first' } }) },
			{ kind: 'creation', event: creation({ event_id: '12', body: { text: 'duplicate' } }) }
		]);

		expect(timelineEvents(timeline).map((event) => event.body?.text)).toEqual(['first', 'second']);
		expect(Object.keys(timeline.events)).toHaveLength(2);
	});
});

describe('mergePatch', () => {
	it('replaces arrays and scalar values according to RFC 7396', () => {
		expect(mergePatch({ a: [1, 2], b: true }, { a: [3], b: false })).toEqual({ a: [3], b: false });
	});

	it('preserves an unknown __proto__ field without changing object prototypes', () => {
		const hostile = JSON.parse('{"event_id":"700","__proto__":{"polluted":true},"body":{"text":"safe"}}') as EventRecord;
		let timeline = applyTransition(createTimeline('general'), { kind: 'creation', event: hostile });
		const event = timeline.events['700'];
		expect(Object.prototype.hasOwnProperty.call(event, '__proto__')).toBe(true);
		expect(event['__proto__']).toEqual({ polluted: true });
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
	});

	it('rejects non-decimal transition ids at the wire boundary', () => {
		expect(toTransition({ event_id: 'not-an-id', body: { text: 'ignored' } })).toBeNull();
		expect(toTransition({ event_id: '0', body: { text: 'ignored' } })).toBeNull();
	});
});
