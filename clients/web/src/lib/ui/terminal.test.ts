import { describe, expect, it } from 'vitest';
import { renderTerminal, TERMINAL_TAIL } from './terminal';

const shown = (text: string): string => renderTerminal(text).map((span) => span.text).join('');

describe('terminal output', () => {
	it('shows plain text as is, in one span', () => {
		expect(renderTerminal('$ make deploy\nok\n')).toEqual([{ text: '$ make deploy\nok\n', className: '', style: '' }]);
	});

	it('colors text with SGR codes and hides the escapes', () => {
		expect(renderTerminal('\u001b[1;32mok\u001b[0m done\n\u001b[31merror:\u001b[m x')).toEqual([
			{ text: 'ok', className: 'ap-term-bold ap-term-fg2', style: '' },
			{ text: ' done\n', className: '', style: '' },
			{ text: 'error:', className: 'ap-term-fg1', style: '' },
			{ text: ' x', className: '', style: '' }
		]);
	});

	it('keeps bright, background, 256-color, and truecolor codes', () => {
		expect(renderTerminal('\u001b[93;44ma\u001b[38;5;196mb\u001b[38;2;1;2;3;48;5;244mc')).toEqual([
			{ text: 'a', className: 'ap-term-fg11 ap-term-bg4', style: '' },
			{ text: 'b', className: 'ap-term-bg4', style: 'color: rgb(255, 0, 0)' },
			{ text: 'c', className: '', style: 'color: rgb(1, 2, 3); background-color: rgb(128, 128, 128)' }
		]);
	});

	it('overwrites a line after a carriage return, as progress bars do', () => {
		expect(shown('downloading  10%\rdownloading 100%\ndone\n')).toBe('downloading 100%\ndone\n');
		expect(shown('50%\r1')).toBe('10%');
		expect(shown('line\r\nnext')).toBe('line\nnext');
	});

	it('erases in line and backs up over backspaces', () => {
		expect(shown('building a long step\r\u001b[Kok')).toBe('ok');
		expect(shown('abc\u001b[2Kd')).toBe('   d');
		expect(shown('ab\bc')).toBe('ac');
	});

	it('drops other escape sequences and control characters', () => {
		expect(shown('\u001b]0;title\u0007\u001b(Bhi\u001b[2A\u001b[?25l\u0007!')).toBe('hi!');
		expect(shown('a\u001b]8;;https://x\u001b\\link\u001b]8;;\u001b\\b')).toBe('alinkb');
	});

	it('waits for the rest of an escape sequence split across chunks', () => {
		expect(shown('ok\u001b[3')).toBe('ok');
		expect(shown('ok\u001b')).toBe('ok');
		expect(shown('ok\u001b[32mgo')).toBe('okgo');
	});

	it('renders only the trailing text, from a line boundary', () => {
		const lines = `${'z'.repeat(TERMINAL_TAIL - 7)}\nlast`;
		expect(shown(`head\n${lines}`)).toBe(lines);
		expect(shown(`${'y'.repeat(TERMINAL_TAIL)}\nlast`)).toBe('last');
	});
});
