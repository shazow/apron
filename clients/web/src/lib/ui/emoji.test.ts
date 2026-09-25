import { describe, expect, it } from 'vitest';
import { currentTheme, NARROW_MAX, PICKER_HEIGHT, PICKER_MIN_HEIGHT, PICKER_WIDTH, pickerColors, placePicker, rgbTriple } from './emoji';

const desktop = { width: 1280, height: 800 };
/** A 28px trigger with its top-left corner at (left, top). */
const button = (left: number, top: number) => ({ left, top, right: left + 28, bottom: top + 28 });

describe('placing the emoji picker', () => {
	it('opens below a trigger when it fits, lined up with its left edge', () => {
		expect(placePicker(button(100, 100), desktop)).toEqual({ mode: 'popover', side: 'below', top: 132, left: 100, width: PICKER_WIDTH, height: PICKER_HEIGHT });
	});

	it('flips above a trigger near the bottom, such as the composer', () => {
		const placed = placePicker(button(900, 740), desktop);
		expect(placed).toMatchObject({ mode: 'popover', side: 'above', height: PICKER_HEIGHT });
		if (placed.mode !== 'popover') throw new Error('expected a popover');
		expect(placed.top + placed.height).toBe(740 - 4);
	});

	it('lines up with the right edge near the viewport’s right, and never leaves the viewport', () => {
		const right = placePicker(button(1200, 100), desktop);
		if (right.mode !== 'popover') throw new Error('expected a popover');
		expect(right.left + right.width).toBe(1228);
		const corner = placePicker({ left: 1270, top: 100, right: 1300, bottom: 128 }, desktop);
		if (corner.mode !== 'popover') throw new Error('expected a popover');
		expect(corner.left + corner.width).toBeLessThanOrEqual(desktop.width - 8);
		const left = placePicker({ left: -40, top: 100, right: -12, bottom: 128 }, desktop);
		if (left.mode !== 'popover') throw new Error('expected a popover');
		expect(left.left).toBe(8);
	});

	it('takes the roomier side and shortens to fit when neither side has the full height', () => {
		const short = { width: 1024, height: 600 };
		const placed = placePicker(button(100, 250), short);
		if (placed.mode !== 'popover') throw new Error('expected a popover');
		expect(placed.side).toBe('below');
		expect(placed.top).toBe(282);
		expect(placed.top + placed.height).toBe(600 - 8);
		// Never below emoji-mart's usable minimum, still inside the viewport.
		const cramped = placePicker(button(100, 150), { width: 1024, height: 330 });
		if (cramped.mode !== 'popover') throw new Error('expected a popover');
		expect(cramped.height).toBe(PICKER_MIN_HEIGHT);
		expect(cramped.top).toBeGreaterThanOrEqual(8);
		expect(cramped.top + cramped.height).toBeLessThanOrEqual(330 - 8);
	});

	it('is a bottom sheet on narrow screens', () => {
		expect(placePicker(button(100, 600), { width: 390, height: 844 })).toEqual({ mode: 'sheet', height: PICKER_HEIGHT });
		expect(placePicker(button(100, 300), { width: 320, height: 480 })).toEqual({ mode: 'sheet', height: 288 });
		expect(placePicker(button(100, 100), { width: NARROW_MAX, height: 800 }).mode).toBe('popover');
	});
});

describe('the emoji picker’s theme', () => {
	it('follows an explicit theme, else the system, with dark as the reference', () => {
		expect(currentTheme('light', false)).toBe('light');
		expect(currentTheme('dark', true)).toBe('dark');
		expect(currentTheme(undefined, true)).toBe('light');
		expect(currentTheme(undefined, false)).toBe('dark');
		expect(currentTheme('sepia', false)).toBe('dark');
	});

	it('reads colors as r, g, b triples', () => {
		expect(rgbTriple('#f28a3c')).toBe('242, 138, 60');
		expect(rgbTriple(' #A83C14 ')).toBe('168, 60, 20');
		expect(rgbTriple('#fff')).toBe('255, 255, 255');
		expect(rgbTriple('#1d1d29cc')).toBe('29, 29, 41');
		expect(rgbTriple('rgb(28, 31, 51)')).toBe('28, 31, 51');
		expect(rgbTriple('rgba(4 4 10 / 0.6)')).toBe('4, 4, 10');
		expect(rgbTriple('var(--accent)')).toBeUndefined();
		expect(rgbTriple('')).toBeUndefined();
	});

	it('maps accent to the rust accent, text to ink and the ground to bg-200', () => {
		const tokens: Record<string, string> = { '--accent': '#f28a3c', '--ink': '#ece9e4', '--bg-200': '#1d1d29', '--bg-100': '#15151f' };
		expect(pickerColors((token) => tokens[token] ?? '')).toEqual({
			'--rgb-accent': '242, 138, 60',
			'--rgb-color': '236, 233, 228',
			'--rgb-background': '29, 29, 41',
			'--rgb-input': '21, 21, 31'
		});
		// A token that isn't a plain color is left to emoji-mart's default.
		expect(pickerColors(() => '')).toEqual({});
	});
});
