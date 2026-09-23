import { mentionsHandle, type MentionPerson } from '$lib/protocol/markdown';
import { isJsonObject, type Embed, type Identity, type MessageRecord } from '$lib/protocol/types';

export function senderName(event: MessageRecord): string {
	return event.from?.name || event.from?.user_id || 'Unknown sender';
}

export function textOf(event: MessageRecord): string {
	return typeof event.body?.text === 'string' ? event.body.text : '';
}

export function embedsOf(event: MessageRecord): Embed[] {
	return Array.isArray(event.body?.embeds)
		? event.body.embeds.filter(isJsonObject).filter((embed): embed is Embed => typeof embed.kind === 'string')
		: [];
}

/** First and last initials, for an avatar with no image. */
export function initials(name: string): string {
	const parts = name.trim().split(/\s+/);
	const first = parts[0]?.[0] ?? '?';
	const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
	return (first + last).toUpperCase();
}

/** One line of a quoted message: the first non-empty line, about 120 characters. */
export function replySnippet(target: MessageRecord): string {
	const line = textOf(target).split('\n').find((part) => part.trim())?.trim() ?? '';
	const short = line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
	return short || (embedsOf(target).length ? 'Attachment' : 'Empty message');
}

/** `aspect-ratio` from an embed's `w`/`h`, so the timeline reserves the space before the media loads. */
export function aspectRatio(embed: Embed): string | undefined {
	return typeof embed.w === 'number' && typeof embed.h === 'number' && embed.w > 0 && embed.h > 0
		? `aspect-ratio: ${embed.w} / ${embed.h}`
		: undefined;
}

export function isOwn(event: MessageRecord, me: Identity | undefined): boolean {
	return Boolean(me && event.from?.user_id === me.user_id);
}

/** A mention is decided here, from the text: `@` + the viewer's name or ID, whole word. Your own messages never ping you. */
export function mentionsMe(event: MessageRecord, me: Identity | undefined): boolean {
	if (!me || isOwn(event, me) || event.deleted) return false;
	return mentionsHandle(textOf(event), [me.name, me.user_id]);
}

/** The senders a list of messages has seen, most recently active first, the viewer marked `me` and always present. */
export function peopleIn(messages: MessageRecord[], me: Identity | undefined): MentionPerson[] {
	const people: MentionPerson[] = [];
	const seen = new Set<string>();
	const person = (from: Identity): MentionPerson => ({
		id: from.user_id,
		...(from.name ? { name: from.name } : {}),
		...(from.avatar ? { avatar: from.avatar } : {}),
		...(from.user_id === me?.user_id ? { me: true } : {})
	});
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const from = messages[index].from;
		if (!from?.user_id || seen.has(from.user_id)) continue;
		seen.add(from.user_id);
		people.push(person(from));
	}
	if (me?.user_id && !seen.has(me.user_id)) people.push(person(me));
	return people;
}

/** Media kinds come from the file's type; anything else is a plain file (Appendix E). */
export function embedFor(file: File, url: string): Embed {
	const kind = file.type.startsWith('image/') ? 'image'
		: file.type.startsWith('video/') ? 'video'
		: file.type.startsWith('audio/') ? 'audio' : 'file';
	return {
		kind, url,
		...(file.type ? { mime: file.type } : {}),
		...(kind === 'file' && file.name ? { name: file.name } : {}),
		...(kind === 'file' && file.size ? { size: file.size } : {})
	};
}

/** Every ID between two in `order`, inclusive, whichever way round; an ID missing from the order yields just the pair. */
export function rangeBetween(order: string[], from: string, to: string): string[] {
	const start = order.indexOf(from);
	const end = order.indexOf(to);
	if (start === -1 || end === -1) return [...new Set([from, to])];
	return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/** Every ID from the earliest picked to the latest, filling the gaps between them. */
export function spanOf(order: string[], picked: string[]): string[] {
	const indexes = picked.map((id) => order.indexOf(id)).filter((index) => index >= 0);
	if (indexes.length < 2) return picked;
	return order.slice(Math.min(...indexes), Math.max(...indexes) + 1);
}
