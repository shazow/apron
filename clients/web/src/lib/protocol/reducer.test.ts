import { describe, expect, it } from 'vitest';
import { applyTransition, applyTransitions, createTimeline, timelineEvents, TimelineReplay } from './reducer';
import { toTransition, type MessageRecord, type Transition } from './types';

const snapshot = (log: number, id = log, fields: Partial<MessageRecord> = {}): Transition => ({
	log_id: String(log),
	message: { message_id: String(id), from: { user_id: 'alice' }, body: { text: 'original' }, ...fields }
});

describe('timeline snapshots', () => {
	it.each([5_000, 50_000])('replays %i messages in pages without mutating the original', (count) => {
		const original = createTimeline('general');
		const replay = new TimelineReplay(original);
		const base = 1_724_803_200_000;
		for (let offset = 0; offset < count; offset += 200) {
			replay.apply(Array.from({ length: Math.min(200, count - offset) }, (_, index) => snapshot(base + offset + index)));
		}
		replay.apply([
			snapshot(base + count, base, { body: { text: 'edited' } }),
			snapshot(base + count + 1, base + 1, { deleted: true, body: undefined }),
			snapshot(base)
		]);
		const result = replay.finish();
		expect(result.order).toEqual(Array.from({ length: count }, (_, index) => String(base + index)));
		expect(result.events[String(base)].body?.text).toBe('edited');
		expect(result.events[String(base + 1)].deleted).toBe(true);
		expect(result.events[String(base + 1)].body).toBeUndefined();
		expect(original).toEqual(createTimeline('general'));
	});

	it('installs unloaded snapshots immediately and ignores older overlapping history', () => {
		const initial = applyTransition(createTimeline('general'), snapshot(35, 20, { body: { text: 'newest' } }));
		expect(initial.events['20'].body?.text).toBe('newest');
		const result = applyTransitions(initial, [snapshot(30, 20), snapshot(40, 2), snapshot(20)]);
		expect(result.order).toEqual(['2', '20']);
		expect(result.events['20'].body?.text).toBe('newest');
		expect(initial.order).toEqual(['20']);
	});

	it('replaces nested state, removes omissions, and preserves literal null', () => {
		const original = applyTransition(createTimeline('general'), snapshot(100, 100, {
			thread_id: 't_a', body: { text: 'old', embeds: [{ kind: 'file' }] }, custom: { nested: 1 }
		}));
		const result = applyTransition(original, snapshot(110, 100, { body: { text: 'new' }, custom: null }));
		expect(result.events['100']).toEqual({ message_id: '100', from: { user_id: 'alice' }, body: { text: 'new' }, custom: null });
		expect(original.events['100'].thread_id).toBe('t_a');
	});

	it('deduplicates and sorts by stable numeric message IDs', () => {
		const result = applyTransitions(createTimeline('general'), [snapshot(12), snapshot(2), snapshot(12, 12, { body: { text: 'duplicate' } })]);
		expect(timelineEvents(result).map((message) => message.message_id)).toEqual(['2', '12']);
		expect(result.events['12'].body?.text).toBe('original');
	});

	it('replays replies without their target and removes references on replacement', () => {
		const initial = applyTransition(createTimeline('general'), snapshot(20, 20, { reply_message_id: '10' }));
		expect(initial.events['20'].reply_message_id).toBe('10');
		expect(initial.events['20'].body?.text).toBe('original');
		const deletedTarget = applyTransition(initial, snapshot(30, 10, { deleted: true, body: undefined }));
		expect(deletedTarget.events['20'].reply_message_id).toBe('10');
		const removed = applyTransitions(deletedTarget, [snapshot(40, 20), snapshot(20, 20, { reply_message_id: '10' })]);
		expect(removed.events['20'].reply_message_id).toBeUndefined();
	});

	it('preserves unknown prototype-like keys without polluting objects', () => {
		const message = JSON.parse('{"message_id":"700","from":{"user_id":"alice"},"__proto__":{"polluted":true},"body":{"text":"safe"}}');
		const result = applyTransition(createTimeline('general'), { log_id: '700', message });
		expect(Object.hasOwn(result.events['700'], '__proto__')).toBe(true);
		expect(result.events['700']['__proto__']).toEqual({ polluted: true });
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
	});

	it('rejects malformed IDs and missing authors at the wire boundary', () => {
		expect(toTransition({ ...snapshot(1), log_id: 'not-an-id' })).toBeNull();
		expect(toTransition({ ...snapshot(1), log_id: '0' })).toBeNull();
		expect(toTransition({ log_id: '1', message: { message_id: '1' } })).toBeNull();
	});
});
