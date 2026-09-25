import { userIn, type ClientSnapshot } from '$lib/protocol/client';
import { safeAvatar } from '$lib/protocol/embeds';
import type { MentionResolver } from '$lib/protocol/markdown';
import type { Identity } from '$lib/protocol/types';

/**
 * Who and where names refer to on the active backend: the latest user object
 * per `user_id` (§3.3), followed through renames, room titles for `@room_id`
 * mentions (Appendix J.3), and the chat server's origin, the only one embed
 * media and streams load from. Every message renders its sender from here,
 * so a rename or a new avatar shows on old messages too.
 */
class Directory {
	origin = $state<string | undefined>();
	you = $state.raw<Identity | undefined>();
	private users = $state.raw<Pick<ClientSnapshot, 'users' | 'userAliases'>>({ users: {}, userAliases: {} });
	private rooms = $state.raw<Record<string, string>>({});

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
		if (!sameEntries(this.users.users, snapshot.users) || !sameEntries(this.users.userAliases, snapshot.userAliases)) {
			this.users = { users: snapshot.users, userAliases: snapshot.userAliases };
		}
		const rooms: Record<string, string> = {};
		for (const listing of [...(snapshot.directory ?? []), ...Object.values(snapshot.threadDirectory).flat()]) rooms[listing.id] = listing.title;
		for (const room of snapshot.rooms) rooms[room.id] = room.title;
		if (!sameEntries(this.rooms, rooms)) this.rooms = rooms;
	}

	forget(): void {
		this.you = undefined;
		this.users = { users: {}, userAliases: {} };
		this.rooms = {};
	}

	/** The latest user object for a sender. */
	person(from: Identity | undefined): Identity | undefined {
		return from ? userIn(this.users, from) : undefined;
	}

	/** A display name: the latest `name`, falling back to the `user_id`. */
	name(from: Identity | undefined): string {
		const person = this.person(from);
		return person?.name || person?.user_id || 'Unknown sender';
	}

	/** An avatar this client will load, if the user has one. */
	avatar(from: Identity | undefined): string | undefined {
		return safeAvatar(this.person(from)?.avatar, this.origin);
	}

	isMe(userId: string): boolean {
		return this.you !== undefined && userIn(this.users, { user_id: userId }).user_id === this.you.user_id;
	}

	/** Resolves `@id` (J.3): a known user wins over a room with the same ID; unknown IDs stay text. */
	readonly resolve: MentionResolver = (id) => {
		const known = this.users.users[id] ?? (this.users.userAliases[id] !== undefined ? this.person({ user_id: id }) : undefined);
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
