import { describe, expect, it } from 'vitest';
import { avatarHue } from './messages';

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
