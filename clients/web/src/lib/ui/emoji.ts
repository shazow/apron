/**
 * Pure helpers for the full emoji picker (emoji-mart): where its popover
 * goes, which theme it takes, and the app's colors in the `r, g, b` form its
 * custom properties want. The picker itself loads lazily, see
 * `emoji-picker.svelte.ts`.
 */

/** Under this width the app is one pane at a time, and the picker is a bottom sheet. */
export const NARROW_MAX = 720;

/** The desktop popover: emoji-mart's nine 36px columns, its padding and scrollbar gutter, and our 1px hairline each side. */
export const PICKER_WIDTH = 9 * 36 + 12 + 16 + 2;
export const PICKER_HEIGHT = 420;
/** emoji-mart's own floor; below it the grid is too short to browse. */
export const PICKER_MIN_HEIGHT = 230;

export interface Box {
	top: number;
	left: number;
	bottom: number;
	right: number;
}

export interface Viewport {
	width: number;
	height: number;
}

export type Placement =
	| { mode: 'popover'; side: 'above' | 'below'; top: number; left: number; width: number; height: number }
	| { mode: 'sheet'; height: number };

export interface PlaceOptions {
	width?: number;
	height?: number;
	/** Between the anchor and the popover. */
	gap?: number;
	/** Kept clear at the viewport's edges. */
	margin?: number;
}

/**
 * Where the picker opens for a trigger at `anchor` (viewport coordinates):
 * below it when it fits, else above, else on the roomier side, shortened to
 * fit; lined up with the anchor's left edge, or its right edge near the
 * viewport's right, and always inside the viewport. Narrow viewports get a
 * bottom sheet instead.
 */
export function placePicker(anchor: Box, viewport: Viewport, options: PlaceOptions = {}): Placement {
	const { width = PICKER_WIDTH, height = PICKER_HEIGHT, gap = 4, margin = 8 } = options;
	if (viewport.width < NARROW_MAX) {
		return { mode: 'sheet', height: Math.max(Math.min(PICKER_MIN_HEIGHT, viewport.height), Math.min(height, Math.round(viewport.height * 0.6))) };
	}
	const below = viewport.height - margin - (anchor.bottom + gap);
	const above = anchor.top - gap - margin;
	const side = below >= height || (above < height && below >= above) ? 'below' : 'above';
	const room = side === 'below' ? below : above;
	const fitted = Math.min(height, Math.max(room, Math.min(PICKER_MIN_HEIGHT, viewport.height - 2 * margin)));
	const rawTop = side === 'below' ? anchor.bottom + gap : anchor.top - gap - fitted;
	const top = clamp(rawTop, margin, viewport.height - margin - fitted);
	const rawLeft = anchor.left + width <= viewport.width - margin ? anchor.left : anchor.right - width;
	const left = clamp(rawLeft, margin, viewport.width - margin - width);
	return { mode: 'popover', side, top, left, width, height: fitted };
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, Math.max(min, max)));
}

/** The theme the app shows: an explicit `data-theme` on the root, else the system's preference (dark is the reference). */
export function currentTheme(dataTheme: string | undefined, prefersLight: boolean): 'light' | 'dark' {
	if (dataTheme === 'light' || dataTheme === 'dark') return dataTheme;
	return prefersLight ? 'light' : 'dark';
}

/** A CSS color as `r, g, b` for emoji-mart's `--rgb-*` properties: `#rgb`, `#rrggbb(aa)` or `rgb()`/`rgba()`. */
export function rgbTriple(color: string): string | undefined {
	const value = color.trim().toLowerCase();
	const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)?.[1];
	if (hex) {
		const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((digit) => digit + digit).join('') : hex.slice(0, 6);
		return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)).join(', ');
	}
	const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(value);
	if (rgb) return rgb.slice(1, 4).map((channel) => Math.round(Math.min(255, Number(channel)))).join(', ');
	return undefined;
}

/** The app tokens emoji-mart's colors follow: accent is the rust `accent`, text is `ink`, the ground `bg-200`. */
export const PICKER_COLORS = {
	'--rgb-accent': '--accent',
	'--rgb-color': '--ink',
	'--rgb-background': '--bg-200',
	'--rgb-input': '--bg-100'
} as const;

/** emoji-mart's `--rgb-*` properties from the app's tokens, read through `read` (a computed style lookup). */
export function pickerColors(read: (token: string) => string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [property, token] of Object.entries(PICKER_COLORS)) {
		const triple = rgbTriple(read(token));
		if (triple) out[property] = triple;
	}
	return out;
}
