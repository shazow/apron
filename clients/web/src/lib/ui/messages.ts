import { mentionedIds, type MentionPerson } from '$lib/protocol/markdown';
import { compareLogIds } from '$lib/protocol/reducer';
import { isJsonObject, type Embed, type Identity, type MessageRecord } from '$lib/protocol/types';
import { directory } from './directory.svelte';

/** The sender's latest display name (§3.3), not necessarily the one the message was posted under. */
export function senderName(event: MessageRecord): string {
	return directory.name(event.from);
}

/** Senders whose `user_id` starts with `@` are system identities (Appendix J.1), shown as quiet centered lines. */
export function isSystem(event: MessageRecord): boolean {
	return event.from?.user_id?.startsWith('@') === true;
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

/**
 * The hue of an avatar placeholder: FNV-1a over the `user_id`, so each person
 * keeps one color everywhere and on every client. The murmur3 finalizer
 * spreads IDs that differ in one character, such as `guest_1` and `guest_2`.
 */
export function avatarHue(userId: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < userId.length; index += 1) {
		hash ^= userId.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x85ebca6b);
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 0xc2b2ae35);
	hash ^= hash >>> 16;
	return (hash >>> 0) % 360;
}

/** One line of a quoted message: the first non-empty line, about 120 characters. */
export function replySnippet(target: MessageRecord): string {
	const line = textOf(target).split('\n').find((part) => part.trim())?.trim() ?? '';
	const short = line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
	return short || (embedsOf(target).length ? 'Attachment' : 'Empty message');
}

export function isOwn(event: MessageRecord, me: Identity | undefined): boolean {
	return Boolean(me && event.from?.user_id === me.user_id);
}

/** A message mentions you when its text names your `user_id` (Appendix J.3), outside code. Your own messages never ping you. */
export function mentionsMe(event: MessageRecord, me: Identity | undefined): boolean {
	if (!me || isOwn(event, me) || event.deleted) return false;
	return mentionedIds(textOf(event), event.body?.format === 'markdown').some((id) => directory.isMe(id) || id === me.user_id);
}

/**
 * Who a composer can mention: the room's `members` from `room_list` (on the
 * demo worker, the users connected now) and anyone who posted after that
 * listing (`asOf`), those who spoke most recently first; without a members
 * list, the room's recent senders. The viewer is marked `me` and is always
 * present. Names and avatars are the latest known.
 */
export function peopleIn(messages: MessageRecord[], me: Identity | undefined, members?: Identity[], asOf?: string): MentionPerson[] {
	const people: MentionPerson[] = [];
	const seen = new Set<string>();
	const listed = members && new Set(members.map((member) => member.user_id));
	const add = (from: Identity, logId?: string): void => {
		if (!from?.user_id || seen.has(from.user_id) || from.user_id.startsWith('@')) return;
		const around = !listed || listed.has(from.user_id) || from.user_id === me?.user_id ||
			(asOf !== undefined && logId !== undefined && compareLogIds(logId, asOf) > 0);
		if (!around) return;
		seen.add(from.user_id);
		const latest = directory.person(from) ?? from;
		const avatar = directory.avatar(from);
		people.push({
			id: from.user_id,
			...(latest.name ? { name: latest.name } : {}),
			...(avatar ? { avatar } : {}),
			...(from.user_id === me?.user_id ? { me: true } : {})
		});
	};
	for (let index = messages.length - 1; index >= 0; index -= 1) add(messages[index].from, messages[index].log_id);
	for (const member of members ?? []) add(member);
	if (me) add(me);
	return people;
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
