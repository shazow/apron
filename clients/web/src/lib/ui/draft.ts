import type { MentionPerson } from '$lib/protocol/markdown';

/**
 * A composer draft: text and mention chips. A chip shows a person's name but
 * is sent as `@user_id` (Appendix A.3), so the wire text is what a reader's
 * client resolves, whatever the person is called by then.
 */
export type DraftPart = string | { id: string };

/** The draft as sent: every chip becomes `@user_id`. */
export function draftText(parts: DraftPart[]): string {
	return parts.map((part) => (typeof part === 'string' ? part : `@${part.id}`)).join('');
}

/**
 * The users a draft mentions (§3.5): one `user_id` per chip, in order. A
 * chip deleted from the text takes its mention with it.
 */
export function draftMentions(parts: DraftPart[]): string[] {
	return [...new Set(parts.filter((part): part is { id: string } => typeof part !== 'string').map((part) => part.id))];
}

/** Merges adjacent text and drops empty text, so equal drafts compare equal. */
export function normalizeDraft(parts: DraftPart[]): DraftPart[] {
	const out: DraftPart[] = [];
	for (const part of parts) {
		if (typeof part !== 'string') out.push(part);
		else if (part && typeof out[out.length - 1] === 'string') out[out.length - 1] += part;
		else if (part) out.push(part);
	}
	return out;
}

export interface CollapseOptions {
	/** Caret position in the draft text; a mention being typed there is left alone. */
	caret: number;
	/** Sending: a mention may end the draft, and nothing is still being typed. */
	final?: boolean;
	/** Whether an ID names a user this client knows, beyond `people`. */
	isUser?: (id: string) => boolean;
}

export interface Collapsed {
	parts: DraftPart[];
	caret: number;
	changed: boolean;
}

const ID_RUN = /^[A-Za-z0-9_.-]+/;
const WORD = /[A-Za-z0-9_]/;
const BEFORE_MENTION = /[A-Za-z0-9]/;

/**
 * Turns a typed `@user_id` or `@name` into a chip once it is finished: an
 * exact ID (case-sensitive), or a name (case-insensitive, spaces allowed)
 * that exactly one person in `people` has, followed by a character that
 * cannot continue it. The longest match wins, an ID over a name of the same
 * length. While typing, a match the caret sits in, or whose text up to the
 * caret could still grow into someone else's longer name or ID, waits.
 * Mentions inside code spans stay text.
 */
export function collapseMentions(parts: DraftPart[], people: MentionPerson[], options: CollapseOptions): Collapsed {
	const { caret, final = false } = options;
	const isUser = (id: string) => people.some((person) => person.id === id) || (options.isUser?.(id) ?? false);
	const out: DraftPart[] = [];
	let changed = false;
	let newCaret = caret;
	let offset = 0;
	let fence = 0;
	parts.forEach((part, index) => {
		if (typeof part !== 'string') {
			out.push(part);
			offset += part.id.length + 1;
			return;
		}
		const followed = index < parts.length - 1;
		const previous = index > 0 ? parts[index - 1] : undefined;
		let last = 0;
		let at = 0;
		while (at < part.length) {
			const char = part[at];
			if (char === '`') {
				let run = 1;
				while (part[at + run] === '`') run += 1;
				fence = fence === 0 ? run : fence === run ? 0 : fence;
				at += run;
				continue;
			}
			const before = at > 0 ? part[at - 1] : typeof previous === 'string' ? previous[previous.length - 1] : undefined;
			if (char !== '@' || fence !== 0 || (before !== undefined && BEFORE_MENTION.test(before))) {
				at += 1;
				continue;
			}
			const hit = mentionAt(part.slice(at + 1), people, isUser, {
				final,
				followed,
				caret: caret - (offset + at + 1)
			});
			if (!hit) {
				at += 1;
				continue;
			}
			if (at > last) out.push(part.slice(last, at));
			out.push({ id: hit.id });
			const end = at + 1 + hit.length;
			if (caret >= offset + end) newCaret += hit.id.length - hit.length;
			else if (caret > offset + at) newCaret = newCaret - (caret - (offset + at)) + hit.id.length + 1;
			changed = true;
			last = at = end;
		}
		if (last < part.length) out.push(part.slice(last));
		offset += part.length;
	});
	return { parts: normalizeDraft(out), caret: newCaret, changed };
}

/**
 * The person `rest` (the text after an `@`) starts with, if the mention is
 * finished. `caret` is relative to `rest`.
 */
function mentionAt(
	rest: string,
	people: MentionPerson[],
	isUser: (id: string) => boolean,
	{ final, followed, caret }: { final: boolean; followed: boolean; caret: number }
): { id: string; length: number } | undefined {
	if (rest.startsWith('@')) return undefined;
	const candidates: Array<{ id: string; length: number; exact: boolean }> = [];
	const run = ID_RUN.exec(rest)?.[0].replace(/[.-]+$/, '');
	if (run && isUser(run)) candidates.push({ id: run, length: run.length, exact: true });
	const lower = rest.toLowerCase();
	for (const person of people) {
		const name = person.name?.trim().toLowerCase();
		if (!name || !lower.startsWith(name)) continue;
		if (name.length < rest.length && WORD.test(rest[name.length])) continue;
		candidates.push({ id: person.id, length: name.length, exact: false });
	}
	if (candidates.length === 0) return undefined;
	const longest = Math.max(...candidates.map((candidate) => candidate.length));
	const best = candidates.filter((candidate) => candidate.length === longest);
	const winner = best.find((candidate) => candidate.exact) ?? best[0];
	if (!winner.exact && best.some((candidate) => candidate.id !== winner.id)) return undefined;
	if (final) return winner;
	// Finished means something follows it, and the caret is past it.
	if (winner.length === rest.length && !followed) return undefined;
	if (caret >= 0 && caret <= winner.length) return undefined;
	// "@Ada Lo" while "Ada Lovelace" is here: still being typed.
	if (caret > winner.length) {
		const typed = lower.slice(0, caret);
		if (!typed.includes('\n') && people.some((person) => {
			const name = person.name?.trim().toLowerCase() ?? '';
			const id = person.id.toLowerCase();
			return (name.length > typed.length && name.startsWith(typed)) || (id.length > typed.length && id.startsWith(typed));
		})) return undefined;
	}
	return winner;
}

/** The `@…` being typed at the caret, for the picker: its text and where its `@` is. */
export function mentionQuery(parts: DraftPart[], caret: number): { query: string; start: number } | undefined {
	let offset = 0;
	for (const part of parts) {
		const length = typeof part === 'string' ? part.length : part.id.length + 1;
		if (typeof part === 'string' && caret >= offset && caret <= offset + length) {
			const match = /(?:^|\s)@([^\s@][^@\n]{0,63}|)$/.exec(part.slice(0, caret - offset));
			if (match) return { query: match[1], start: caret - match[1].length - 1 };
		}
		offset += length;
	}
	return undefined;
}

/** Replaces the draft text from `start` to `end` with a chip for `id` and a space; the caret goes after the space. */
export function insertMention(parts: DraftPart[], start: number, end: number, id: string): { parts: DraftPart[]; caret: number } {
	const out: DraftPart[] = [];
	let offset = 0;
	let placed = false;
	for (const part of parts) {
		const length = typeof part === 'string' ? part.length : part.id.length + 1;
		if (typeof part === 'string' && !placed && start >= offset && end <= offset + length) {
			const after = part.slice(end - offset);
			out.push(part.slice(0, start - offset), { id }, after.startsWith(' ') ? after : ` ${after}`);
			placed = true;
		} else {
			out.push(part);
		}
		offset += length;
	}
	if (!placed) out.push({ id }, ' ');
	return { parts: normalizeDraft(out), caret: (placed ? start : offset) + id.length + 2 };
}
