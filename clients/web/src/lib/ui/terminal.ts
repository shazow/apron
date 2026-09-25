/**
 * Terminal output for `terminal` stream embeds (§4.6.5): what a program
 * printed as it would look on screen. Carriage returns and backspaces move the
 * cursor so progress lines overwrite themselves, erase-in-line clears, SGR
 * sets colors and emphasis, and every other escape sequence is dropped rather
 * than shown. The result is text and class names, never HTML.
 */

/** How much trailing text is rendered, matching what the server keeps of a stream. */
export const TERMINAL_TAIL = 64 * 1024;

/** A run of text in one style. `className` and `style` are empty for plain text. */
export interface TerminalSpan {
	text: string;
	className: string;
	style: string;
}

/** A palette index (0–15, drawn from the theme) or a CSS color from 256-color and truecolor codes. */
type Color = number | string;

interface Style {
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	fg?: Color;
	bg?: Color;
}

const PLAIN: Style = {};
const ESC = '\u001b';
const BEL = '\u0007';

/** Renders terminal output as styled spans, lines separated by `\n` inside them. */
export function renderTerminal(text: string): TerminalSpan[] {
	const chars = Array.from(tail(text));
	const lines: { chars: string[]; styles: Style[] }[] = [{ chars: [], styles: [] }];
	let row = 0;
	let col = 0;
	let style = PLAIN;

	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		const line = lines[row];
		if (ch === ESC) {
			const next = chars[i + 1];
			if (next === undefined) break;
			if (next === '[') {
				// CSI: parameter and intermediate bytes, then a final byte in @–~.
				let end = i + 2;
				while (end < chars.length && !(chars[end] >= '@' && chars[end] <= '~')) end++;
				if (end >= chars.length) break;
				const params = chars.slice(i + 2, end).join('');
				if (chars[end] === 'm') style = sgr(style, params);
				else if (chars[end] === 'K') eraseInLine(line, col, params);
				i = end;
			} else if (next === ']' || next === 'P' || next === '_' || next === '^') {
				// OSC and other strings end with BEL or ESC \.
				let end = i + 2;
				while (end < chars.length && chars[end] !== BEL && !(chars[end] === ESC && chars[end + 1] === '\\')) end++;
				if (end >= chars.length) break;
				i = chars[end] === BEL ? end : end + 1;
			} else {
				// Two-byte escapes, or three for a character set designation such as ESC ( B.
				i += '()*+'.includes(next) ? 2 : 1;
			}
		} else if (ch === '\n') {
			row++;
			col = 0;
			if (row === lines.length) lines.push({ chars: [], styles: [] });
		} else if (ch === '\r') {
			col = 0;
		} else if (ch === '\b') {
			col = Math.max(0, col - 1);
		} else if (ch !== '\t' && ch < ' ') {
			// Other control characters (bells, shifts) have nothing to show.
		} else {
			while (line.chars.length < col) {
				line.chars.push(' ');
				line.styles.push(PLAIN);
			}
			line.chars[col] = ch;
			line.styles[col] = style;
			col++;
		}
	}

	const spans: TerminalSpan[] = [];
	const push = (text: string, style: Style): void => {
		const className = classNames(style);
		const css = inlineStyle(style);
		const last = spans[spans.length - 1];
		if (last && last.className === className && last.style === css) last.text += text;
		else spans.push({ text, className, style: css });
	};
	lines.forEach((line, index) => {
		if (index > 0) push('\n', PLAIN);
		line.chars.forEach((ch, at) => push(ch, line.styles[at]));
	});
	return spans;
}

/** The trailing text to render, starting at a line boundary when it has to be cut. */
function tail(text: string): string {
	if (text.length <= TERMINAL_TAIL) return text;
	const cut = text.length - TERMINAL_TAIL;
	const newline = text.indexOf('\n', cut);
	return newline === -1 ? text.slice(cut) : text.slice(newline + 1);
}

function eraseInLine(line: { chars: string[]; styles: Style[] }, col: number, params: string): void {
	const mode = params === '' ? 0 : Number(params);
	if (mode === 0) {
		line.chars.length = Math.min(line.chars.length, col);
		line.styles.length = line.chars.length;
	} else if (mode === 1) {
		for (let at = 0; at <= col && at < line.chars.length; at++) {
			line.chars[at] = ' ';
			line.styles[at] = PLAIN;
		}
	} else if (mode === 2) {
		line.chars.fill(' ');
		line.styles.fill(PLAIN);
	}
}

/** Applies Select Graphic Rendition parameters; unsupported ones are ignored. */
function sgr(style: Style, params: string): Style {
	const codes = params === '' ? [0] : params.split(';').map((code) => (code === '' ? 0 : Number(code)));
	let next = { ...style };
	for (let i = 0; i < codes.length; i++) {
		const code = codes[i];
		if (code === 0) next = {};
		else if (code === 1) next.bold = true;
		else if (code === 2) next.dim = true;
		else if (code === 3) next.italic = true;
		else if (code === 4) next.underline = true;
		else if (code === 22) next.bold = next.dim = undefined;
		else if (code === 23) next.italic = undefined;
		else if (code === 24) next.underline = undefined;
		else if (code >= 30 && code <= 37) next.fg = code - 30;
		else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
		else if (code === 39) next.fg = undefined;
		else if (code >= 40 && code <= 47) next.bg = code - 40;
		else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
		else if (code === 49) next.bg = undefined;
		else if (code === 38 || code === 48) {
			const [color, used] = extendedColor(codes, i + 1);
			if (color !== undefined) next[code === 38 ? 'fg' : 'bg'] = color;
			i += used;
		}
	}
	return next;
}

/** `5;n` (256 colors) or `2;r;g;b` (truecolor), and how many parameters it used. */
function extendedColor(codes: number[], at: number): [Color | undefined, number] {
	if (codes[at] === 5) {
		const n = codes[at + 1];
		if (!(n >= 0 && n <= 255)) return [undefined, 2];
		if (n < 16) return [n, 2];
		if (n >= 232) {
			const level = 8 + (n - 232) * 10;
			return [`rgb(${level}, ${level}, ${level})`, 2];
		}
		const cube = n - 16;
		const level = (step: number): number => (step === 0 ? 0 : 55 + step * 40);
		return [`rgb(${level(Math.floor(cube / 36))}, ${level(Math.floor(cube / 6) % 6)}, ${level(cube % 6)})`, 2];
	}
	if (codes[at] === 2) {
		const rgb = codes.slice(at + 1, at + 4);
		if (rgb.length < 3 || rgb.some((value) => !(value >= 0 && value <= 255))) return [undefined, 4];
		return [`rgb(${rgb.join(', ')})`, 4];
	}
	return [undefined, 0];
}

function classNames(style: Style): string {
	const names: string[] = [];
	if (style.bold) names.push('ap-term-bold');
	if (style.dim) names.push('ap-term-dim');
	if (style.italic) names.push('ap-term-italic');
	if (style.underline) names.push('ap-term-underline');
	if (typeof style.fg === 'number') names.push(`ap-term-fg${style.fg}`);
	if (typeof style.bg === 'number') names.push(`ap-term-bg${style.bg}`);
	return names.join(' ');
}

function inlineStyle(style: Style): string {
	const rules: string[] = [];
	if (typeof style.fg === 'string') rules.push(`color: ${style.fg}`);
	if (typeof style.bg === 'string') rules.push(`background-color: ${style.bg}`);
	return rules.join('; ');
}
