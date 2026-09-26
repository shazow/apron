import { userIn, type ClientSnapshot } from '$lib/protocol/client';
import { safeAvatar } from '$lib/protocol/embeds';
import type { MentionResolver } from '$lib/protocol/markdown';
import type { Identity } from '$lib/protocol/types';

type Users = Pick<ClientSnapshot, 'users' | 'recordedUsers' | 'userAliases'>;

/**
 * Who and where names refer to on the active backend: the kept user object
 * per `user_id` (§3.3), followed through renames, the latest recorded object
 * as a fallback, room titles for `@room_id` mentions (Appendix A.3), and the
 * chat server's origin, the only one embed media and streams load from.
 * Every message renders its sender from here, field by field: the kept
 * object, then the `from` the message carries, then the `user_id`. So a
 * rename or a new avatar shows on old messages too.
 */
class Directory {
	origin = $state<string | undefined>();
	you = $state.raw<Identity | undefined>();
	private users = $state.raw<Users>({ users: {}, recordedUsers: {}, userAliases: {} });
	private rooms = $state.raw<Record<string, string>>({});
	/**
	 * Every known `user_id` by the display name it shows under: its kept name,
	 * else the name it was last recorded with, else its `user_id`. Retired IDs
	 * count as the identity that replaced them.
	 */
	private readonly byName = $derived.by(() => {
		const { users, recordedUsers, userAliases } = this.users;
		const names = new Map<string, Set<string>>();
		for (const id of new Set([...Object.keys(users), ...Object.keys(recordedUsers)])) {
			if (userAliases[id] !== undefined) continue;
			const name = users[id]?.name || recordedUsers[id]?.name || id;
			let ids = names.get(name);
			if (!ids) names.set(name, (ids = new Set()));
			ids.add(id);
		}
		return names;
	});

	/**
	 * Takes an authenticated snapshot; the last one is kept while a reconnect
	 * rebuilds the view. The client emits fresh records on every frame, so
	 * unchanged ones are kept: every message body renders from them, and a
	 * typing notice or an upload's progress should not render them all again.
	 */
	apply(snapshot: ClientSnapshot, origin: string | undefined): void {
		this.origin = origin;
		if (!snapshot.authenticated) return;
		this.you = snapshot.you;
		const current = this.users;
		if (!sameEntries(current.users, snapshot.users) || !sameEntries(current.recordedUsers, snapshot.recordedUsers) || !sameEntries(current.userAliases, snapshot.userAliases)) {
			this.users = { users: snapshot.users, recordedUsers: snapshot.recordedUsers, userAliases: snapshot.userAliases };
		}
		const rooms: Record<string, string> = {};
		for (const listing of [...(snapshot.directory ?? []), ...Object.values(snapshot.threadDirectory).flat()]) rooms[listing.id] = listing.title;
		for (const room of snapshot.rooms) rooms[room.id] = room.title;
		if (!sameEntries(this.rooms, rooms)) this.rooms = rooms;
	}

	forget(): void {
		this.you = undefined;
		this.users = { users: {}, recordedUsers: {}, userAliases: {} };
		this.rooms = {};
	}

	/** How to show a user a frame names (a `from`, a member): the kept fields, else the recorded ones. */
	person(from: Identity | undefined): Identity | undefined {
		return from ? userIn(this.users, from) : undefined;
	}

	/** A display name: the kept `name`, else the recorded one, falling back to the `user_id`. */
	name(from: Identity | undefined): string {
		const person = this.person(from);
		return person?.name || person?.user_id || 'Unknown sender';
	}

	/** An avatar this client will load, if the user has one. */
	avatar(from: Identity | undefined): string | undefined {
		return safeAvatar(this.person(from)?.avatar, this.origin);
	}

	/**
	 * Whether another known `user_id` shows under the same display name, so
	 * this one must show its `@user_id` beside it (§3.3): no one passes as
	 * someone else.
	 */
	sharesName(from: Identity | undefined): boolean {
		const person = this.person(from);
		if (!person) return false;
		const ids = this.byName.get(this.name(from));
		if (!ids) return false;
		for (const id of ids) if (id !== person.user_id && id !== from!.user_id) return true;
		return false;
	}

	isMe(userId: string): boolean {
		return this.you !== undefined && userIn(this.users, { user_id: userId }).user_id === this.you.user_id;
	}

	/** Resolves `@id` (Appendix A.3): a known user wins over a room with the same ID; unknown IDs stay text. */
	readonly resolve: MentionResolver = (id) => {
		const { users, recordedUsers, userAliases } = this.users;
		const recorded = recordedUsers[id];
		const known = users[id] || userAliases[id] !== undefined || recorded ? this.person(recorded ?? { user_id: id }) : undefined;
		if (known) return { kind: 'user', id, name: known.name || known.user_id, me: this.isMe(id) };
		const title = this.rooms[id];
		if (title !== undefined) return { kind: 'room', id, title };
		return undefined;
	};
}

/** The same keys holding the same values; the client keeps an identity object until that user changes. */
function sameEntries<T>(a: Record<string, T>, b: Record<string, T>): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

export const directory = new Directory();
