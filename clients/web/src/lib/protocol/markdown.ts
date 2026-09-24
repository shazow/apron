import { HtmlRenderer, Parser } from 'commonmark';

const parser = new Parser();
// A line break typed in a chat message is meant: soft breaks render as `<br />`, not as a space.
const renderer = new HtmlRenderer({ safe: true, softbreak: '<br />' });

/**
 * What an `@id` mention names (Appendix J.3): a known user, rendered with
 * their latest name, or a room, rendered as a link to it. Unknown IDs render
 * as written.
 */
export type MentionTarget =
	| { kind: 'user'; id: string; name: string; me?: boolean }
	| { kind: 'room'; id: string; title: string };

/** Looks an ID up; when it names both a user and a room, answer with the user. */
export type MentionResolver = (id: string) => MentionTarget | undefined;

/** Someone a composer can mention: a room member or a recent sender. */
export interface MentionPerson {
	id: string;
	name?: string;
	avatar?: string;
	/** The viewer. */
	me?: boolean;
}

/**
 * `@` then an optional second `@` (system identities, J.1) and a run of
 * `[A-Za-z0-9_.-]`, not preceded by a letter or digit. Trailing `.` and `-`
 * are not part of the ID.
 */
const MENTION = /@(@?[A-Za-z0-9_.-]+)/g;

/** CommonMark rendering with raw HTML and unsafe URL schemes disabled, keeping typed line breaks. */
export function renderMarkdown(source: string, resolve?: MentionResolver): string {
	return linkMentions(renderer.render(parser.parse(source)), resolve);
}

/** A plain body as HTML: escaped, with mentions linked. Line breaks are kept by CSS (`pre-wrap`). */
export function renderPlain(source: string, resolve?: MentionResolver): string {
	return chipText(escapeHtml(source), resolve);
}

/** Every ID a body mentions (J.3), outside Markdown code spans and blocks. */
export function mentionedIds(source: string, markdown: boolean): string[] {
	const ids: string[] = [];
	const collect: MentionResolver = (id) => {
		ids.push(id);
		return undefined;
	};
	if (markdown) renderMarkdown(source, collect);
	else renderPlain(source, collect);
	return ids;
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The markup of the design system's Mention component. */
function mentionChip(target: MentionTarget): string {
	if (target.kind === 'room') {
		return `<button type="button" class="ap-mention ap-mention-room" data-room-id="${escapeHtml(target.id)}" title="Open ${escapeHtml(target.title)}">${escapeHtml(target.title)}</button>`;
	}
	const title = target.name !== target.id ? ` title="@${escapeHtml(target.id)}"` : '';
	return `<span class="ap-mention${target.me ? ' ap-mention-me' : ''}" data-user-id="${escapeHtml(target.id)}"${title}>@${escapeHtml(target.name)}</span>`;
}

/**
 * Links `@id` in the rendered HTML's text, leaving tags, attributes and code
 * alone: an ID inside `<code>` is code, not a mention.
 */
function linkMentions(html: string, resolve?: MentionResolver): string {
	if (!resolve) return html;
	let out = '';
	let index = 0;
	let codeDepth = 0;
	while (index < html.length) {
		const tagStart = html.indexOf('<', index);
		const text = html.slice(index, tagStart === -1 ? undefined : tagStart);
		out += codeDepth > 0 ? text : chipText(text, resolve);
		if (tagStart === -1) break;
		const tagEnd = html.indexOf('>', tagStart);
		if (tagEnd === -1) {
			out += html.slice(tagStart);
			break;
		}
		const tag = html.slice(tagStart, tagEnd + 1);
		if (/^<(code|pre|a)[\s>]/i.test(tag)) codeDepth += 1;
		else if (/^<\/(code|pre|a)\s*>$/i.test(tag) && codeDepth > 0) codeDepth -= 1;
		out += tag;
		index = tagEnd + 1;
	}
	return out;
}

/** Replaces mentions in escaped text. Escaped entities never contain ID characters after an `@`. */
function chipText(text: string, resolve?: MentionResolver): string {
	if (!resolve) return text;
	return text.replace(MENTION, (match, raw: string, offset: number) => {
		const before = text[offset - 1];
		if (before !== undefined && /[A-Za-z0-9]/.test(before)) return match;
		const id = raw.replace(/[.-]+$/, '');
		if (!id || id === '@') return match;
		const target = resolve(id);
		const rest = raw.slice(id.length);
		return target ? mentionChip(target) + rest : match;
	});
}
