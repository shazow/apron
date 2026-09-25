import { describe, expect, it } from 'vitest';
import type { MessageRecord } from '$lib/protocol/types';
import { avatarHue, mentionsMe, mentionsOf } from './messages';

describe('avatarHue', () => {
	it('gives each user_id one stable hue and spreads different IDs apart', () => {
		expect(avatarHue('guest_1')).toBe(avatarHue('guest_1'));
		const hues = new Set(Array.from({ length: 50 }, (_, index) => avatarHue(`guest_${index}`)));
		expect(hues.size).toBeGreaterThan(40);
		for (const hue of hues) expect(hue).toBeGreaterThanOrEqual(0);
		for (const hue of hues) expect(hue).toBeLessThan(360);
	});

	it('spreads IDs that differ in one character across the wheel', () => {
		const buckets = new Set(Array.from({ length: 12 }, (_, index) => Math.floor(avatarHue(`guest_${index + 1}`) / 30)));
		expect(buckets.size).toBeGreaterThanOrEqual(7);
	});
});

describe('mentionsMe', () => {
	const me = { user_id: 'guest_me', name: 'Sam' };
	const event = (body: MessageRecord['body'], from = 'ada'): MessageRecord => ({ message_id: '10', log_id: '10', room_id: 'general', from: { user_id: from }, body });

	it('reads body.mentions only, never the text', () => {
		expect(mentionsMe(event({ text: '@guest_me look' }), me)).toBe(false);
		expect(mentionsMe(event({ text: 'look', mentions: ['guest_me'] }), me)).toBe(true);
		expect(mentionsMe(event({ text: '@guest_me', mentions: ['bob'] }), me)).toBe(false);
		expect(mentionsOf(event({ text: '', mentions: ['bob', 7 as unknown as string, 'carol'] }))).toEqual(['bob', 'carol']);
	});

	it('never counts your own messages or tombstones', () => {
		expect(mentionsMe(event({ text: 'hi', mentions: ['guest_me'] }, 'guest_me'), me)).toBe(false);
		expect(mentionsMe({ ...event(undefined), deleted: true }, me)).toBe(false);
	});
});
