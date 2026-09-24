import { describe, expect, it } from 'vitest';
import { idDateTime, idIso, idTime, idTimeCompact } from './time';

describe('timestamps', () => {
	const id = String(Date.UTC(2026, 8, 14, 15, 4));

	it('follow the browser locale, with a compact form that drops AM/PM', () => {
		const expected = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(Number(id));
		expect(idTime(id)).toBe(expected);
		expect(idTimeCompact(id)).not.toMatch(/[AP]\.?M\.?/i);
		expect(idTimeCompact(id)).toMatch(/\d{1,2}.\d{2}/);
		expect(idDateTime(id)).toMatch(/2026/);
		expect(idIso(id)).toBe('2026-09-14T15:04:00.000Z');
	});

	it('are empty for IDs that carry no time', () => {
		expect(idTime('opaque')).toBe('');
		expect(idTimeCompact('opaque')).toBe('');
		expect(idIso('opaque')).toBeUndefined();
	});
});
