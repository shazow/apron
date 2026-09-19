import { HtmlRenderer, Parser } from 'commonmark';

const parser = new Parser();
const renderer = new HtmlRenderer({ safe: true });

/** CommonMark rendering with raw HTML and unsafe URL schemes disabled. */
export function renderMarkdown(source: string): string {
	return renderer.render(parser.parse(source));
}

export function safeUrl(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value.trim()) return undefined;
	try {
		const parsed = new URL(value, 'https://invalid.local');
		if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return value;
		return undefined;
	} catch {
		return undefined;
	}
}

export function formatBytes(value: unknown): string {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '';
	if (value < 1024) return `${value} B`;
	const units = ['KB', 'MB', 'GB'];
	let amount = value / 1024;
	let index = 0;
	while (amount >= 1024 && index < units.length - 1) {
		amount /= 1024;
		index += 1;
	}
	return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[index]}`;
}
