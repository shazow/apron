import { HtmlRenderer, Parser } from 'commonmark';

const parser = new Parser();
// A line break typed in a chat message is meant: soft breaks render as `<br />`, not as a space.
const renderer = new HtmlRenderer({ safe: true, softbreak: '<br />' });

/** Someone the room has seen speak, so an `@handle` in a body can become a chip. */
export interface MentionPerson {
	id: string;
	name?: string;
	avatar?: string;
	/** The viewer: their chip is the rust one, and the message pings them. */
	me?: boolean;
}

/** Matches a rendered handle: the `@`, then the letters, kept out of code and tags. */
interface MentionHandle {
	/** The handle as it appears in rendered HTML, escaped the way commonmark escapes text. */
	text: string;
	person: MentionPerson;
}

/** CommonMark rendering with raw HTML and unsafe URL schemes disabled, keeping typed line breaks. */
export function renderMarkdown(source: string, people: MentionPerson[] = []): string {
	return linkMentions(renderer.render(parser.parse(source)), people);
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The handles a body may mention: every sender's name and ID, longest first so
 * `@Alice Chen` wins over `@Alice`. Rendered text is already escaped, so the
 * handles are escaped the same way before they are matched against it.
 */
function mentionHandles(people: MentionPerson[]): MentionHandle[] {
	const handles: MentionHandle[] = [];
	const seen = new Set<string>();
	for (const person of people) {
		for (const handle of [person.name, person.id]) {
			const trimmed = handle?.trim();
			if (!trimmed) continue;
			const key = trimmed.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			handles.push({ text: escapeHtml(trimmed), person });
		}
	}
	return handles.sort((a, b) => b.text.length - a.text.length);
}

/** A mention ends where a word ends: another letter or digit right after it isn't one. */
function boundedMatch(text: string, at: number, handle: string): boolean {
	if (text.slice(at, at + handle.length).toLowerCase() !== handle.toLowerCase()) return false;
	const after = text[at + handle.length];
	return after === undefined || !/[\p{L}\p{N}_]/u.test(after);
}

/** The chip the design system's Mention component renders. */
function mentionChip(person: MentionPerson, label: string): string {
	const name = person.name?.trim() || person.id;
	const title = person.id && person.id !== name ? ` title="${escapeHtml(person.id)}"` : '';
	return `<span class="ap-mention${person.me ? ' ap-mention-me' : ''}" data-id="${escapeHtml(person.id)}"${title}>@${label}</span>`;
}

/**
 * Turns `@handle` into a Mention chip in the rendered HTML's text, leaving tags,
 * attributes and code spans alone — a handle inside `<code>` is code, not a ping.
 */
function linkMentions(html: string, people: MentionPerson[]): string {
	const handles = mentionHandles(people);
	if (handles.length === 0) return html;
	let out = '';
	let index = 0;
	let codeDepth = 0;
	while (index < html.length) {
		const tagStart = html.indexOf('<', index);
		const text = html.slice(index, tagStart === -1 ? undefined : tagStart);
		out += codeDepth > 0 ? text : chipText(text, handles);
		if (tagStart === -1) break;
		const tagEnd = html.indexOf('>', tagStart);
		if (tagEnd === -1) {
			out += html.slice(tagStart);
			break;
		}
		const tag = html.slice(tagStart, tagEnd + 1);
		if (/^<(code|pre)[\s>]/i.test(tag)) codeDepth += 1;
		else if (/^<\/(code|pre)\s*>$/i.test(tag) && codeDepth > 0) codeDepth -= 1;
		out += tag;
		index = tagEnd + 1;
	}
	return out;
}

function chipText(text: string, handles: MentionHandle[]): string {
	let out = '';
	let index = 0;
	while (index < text.length) {
		const at = text.indexOf('@', index);
		if (at === -1) {
			out += text.slice(index);
			break;
		}
		out += text.slice(index, at);
		const before = text[at - 1];
		const opens = before === undefined || !/[\p{L}\p{N}_@]/u.test(before);
		const handle = opens ? handles.find((candidate) => boundedMatch(text, at + 1, candidate.text)) : undefined;
		if (!handle) {
			out += '@';
			index = at + 1;
			continue;
		}
		out += mentionChip(handle.person, text.slice(at + 1, at + 1 + handle.text.length));
		index = at + 1 + handle.text.length;
	}
	return out;
}

/** Whether a body mentions one of these handles, by the same rule the chips follow. */
export function mentionsHandle(source: string, handles: (string | undefined)[]): boolean {
	const people: MentionPerson[] = handles
		.filter((handle): handle is string => Boolean(handle?.trim()))
		.map((handle) => ({ id: handle }));
	if (people.length === 0) return false;
	const escaped = escapeHtml(source);
	return chipText(escaped, mentionHandles(people)) !== escaped;
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
