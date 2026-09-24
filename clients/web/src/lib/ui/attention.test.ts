import { describe, expect, it } from 'vitest';
import { tabTitle } from './attention';

describe('tab title', () => {
	it('leads with the unread count and flashes for a mention', () => {
		expect(tabTitle(0, false)).toBe('Apron');
		expect(tabTitle(3, false)).toBe('(3) Apron');
		expect(tabTitle(1200, false)).toBe('(999+) Apron');
		expect(tabTitle(3, true)).toBe('@ You were mentioned');
	});
});
