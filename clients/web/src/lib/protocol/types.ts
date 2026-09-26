/**
 * Wire types and decoders for Apron protocol v6 (PROTOCOL.md at the repository
 * root). Decoders normalize server records to the fields the protocol defines
 * and drop unknown top-level keys (§1: unknown keys MAY be dropped), while
 * copying known values exactly, including `ext`, literal `null`s, unknown embed
 * kinds, and prototype-like keys such as `"__proto__"`.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject | undefined;
export interface JsonObject {
	[key: string]: JsonValue;
}

/**
 * Optional features of `server.params.caps` (§4) that this client uses;
 * it ignores the rest.
 */
export type Capability = 'history' | 'edit' | 'rooms' | 'reactions' | 'activity' | 'embed:upload' | 'embed:stream' | 'command';

/**
 * A user object (§3.3). Current objects (`you`, `new` in `user`, room
 * `members` and `users`) merge into the one kept per `user_id`; recorded ones
 * (a message's or reaction's `from`, a membership's `user`) describe the user
 * as of their record and are never merged.
 */
export interface Identity extends JsonObject {
	user_id: string;
	name?: string;
	avatar?: string;
	ext?: JsonObject;
}

export interface MessageBody extends JsonObject {
	text?: string;
	/** `plain` when absent (§3.5). */
	format?: 'plain' | 'markdown' | string;
	embeds?: Embed[];
	/** The `user_id`s the message mentions (§3.5): the only thing that decides who is mentioned. */
	mentions?: string[];
}

/** OpenGraph description of an embed (§4.6.1): `og:` prefix dropped, structured properties nested. */
export interface OpenGraph extends JsonObject {
	title?: string;
	description?: string;
	site_name?: string;
	image?: OpenGraphMedia;
	video?: OpenGraphMedia;
	audio?: OpenGraphMedia;
}

export interface OpenGraphMedia extends JsonObject {
	url: string;
	type?: string;
	width?: number;
	height?: number;
	alt?: string;
}

/**
 * One entry of `body.embeds` (§4.6). `kind` picks the renderer:
 * `upload` (a file the server hosts; pending while `url` is absent), `stream`
 * (live text at `url`, finished with `text`), `iframe`, `html`, and any other
 * kind from `og` or as a fallback card.
 */
export interface Embed extends JsonObject {
	kind: string;
	embed_id?: string;
	url?: string;
	title?: string;
	text?: string;
	format?: string;
	html?: string;
	height?: number;
	og?: OpenGraph;
}

/** A bare message reference (`reply_to`, `intro_message`) as clients send and store it. */
export interface MessageRef extends JsonObject {
	message_id: string;
}

/**
 * A message snapshot: the complete state of one message at one `log_id`
 * (§3.5). Stored snapshots keep only these fields; `reply_to` is always kept
 * bare (an embedded snapshot is installed as its own record).
 */
export interface MessageRecord extends JsonObject {
	message_id: string;
	log_id: string;
	room_id: string;
	from: Identity;
	body?: MessageBody;
	reply_to?: MessageRef;
	deleted?: boolean;
	ext?: JsonObject;
}

/**
 * A room record (§3.4) without delivery fields. `intro_message` is stored bare;
 * its embedded snapshot, when a server sent one, is installed as a message.
 */
export interface RoomRecord extends JsonObject {
	room_id: string;
	/** Absent only from servers without cap `history`. */
	log_id?: string;
	/** Marks a thread; fixed at creation. */
	parent_room_id?: string;
	title?: string;
	intro_message?: MessageRef;
	ext?: JsonObject;
}

/** One user's complete emoji set on one message at one `log_id` (§4.5). */
export interface ReactionSet {
	log_id: string;
	message_id: string;
	/** The room the message was in when the set was logged. */
	room_id?: string;
	from: Identity;
	emojis: string[];
}

export interface ServerParams {
	protocol: number;
	name?: string;
	caps?: string[];
	auth: string[];
	/** Extension metadata (§3.1). */
	ext?: ServerExt;
	/** Seconds between client pings (§1, §3.1). */
	ping?: number;
}

export interface ServerExt extends JsonObject {
	demo?: DemoParams;
}

/** Non-standard hints from the public demo worker, in `server.ext.demo`. */
export interface DemoParams extends JsonObject {
	retention_seconds?: number;
	cleanup_seconds?: number;
	max_frame_bytes?: number;
	max_message_text_bytes?: number;
	max_snapshot_bytes?: number;
	guest_posts_per_minute?: number;
	registered_posts_per_minute?: number;
	/** `false` when every room is joined for good and `room_leave` is always denied. */
	room_leave?: boolean;
	/** `false` when the server keeps no read cursors, so `read_message_id` is not worth sending. */
	read_cursors?: boolean;
}

/**
 * Delivery fields of a room record (§3.4): this client's view, not logged.
 * Clients always take the latest values.
 */
export interface RoomDelivery {
	latest_log_id?: string;
	history_log_id?: string | null;
	/**
	 * Every user who has joined the room, as current user objects (possibly
	 * `user_id` only): in `room_list` with `members: true` and in
	 * `room_update` `joined` (§4.3.1, §4.3.3).
	 */
	members?: Identity[];
}

/**
 * A history page (§4.1). Every array MAY be omitted when empty; clients treat
 * a missing array as empty. An empty slice has neither bound.
 */
export interface HistoryResult {
	rooms?: unknown[];
	messages?: unknown[];
	reactions?: unknown[];
	membership?: unknown[];
	first_log_id?: string;
	last_log_id?: string;
	more: boolean;
	latest_log_id: string;
	history_log_id: string | null;
}

/**
 * One user's membership of one room at one `log_id` (§4.3.2): an element of a
 * `membership` record's `members`, keyed by `(room_id, user.user_id)`. `user`
 * is a recorded object.
 */
export interface MembershipEntry {
	log_id: string;
	room_id: string;
	user: Identity;
	joined: boolean;
}

export interface RpcError extends JsonObject {
	code: number;
	message: string;
	data?: JsonValue;
}

export interface WireFrame {
	jsonrpc?: '2.0';
	method?: string;
	id?: string | null;
	params?: JsonObject;
	result?: JsonObject;
	error?: RpcError;
	[key: string]: JsonValue | undefined;
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
	return typeof value === 'string';
}

/** Log IDs and message IDs are positive decimal strings below 2^53 (§2). */
export function isLogId(value: unknown): value is string {
	return typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number(value) < 2 ** 53;
}

export function isIdentity(value: unknown): value is Identity {
	return isJsonObject(value) && typeof value.user_id === 'string';
}

/** Deep copy into null-prototype objects so keys such as `"__proto__"` stay plain data. */
export function cloneJson<T extends JsonValue>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
	if (isJsonObject(value)) {
		const copy: JsonObject = Object.create(null);
		for (const key of Object.keys(value)) copy[key] = cloneJson(value[key]);
		return copy as T;
	}
	return value;
}

/** A bare reference `{message_id}` from a reference or embedded snapshot, if valid. */
export function toMessageRef(value: unknown): MessageRef | undefined {
	if (!isJsonObject(value) || !isLogId(value.message_id)) return undefined;
	return { message_id: value.message_id };
}

/**
 * Decode a flat message snapshot (a `message` notification's params, a
 * history entry, or an embedded snapshot). Returns the normalized record and
 * any embedded snapshots it carried (`reply_to` with a `log_id`), or null when
 * the value is not a valid snapshot.
 */
export function decodeMessage(value: unknown): { record: MessageRecord; embedded: MessageRecord[] } | null {
	if (!isJsonObject(value)) return null;
	if (!isLogId(value.message_id) || !isLogId(value.log_id) || typeof value.room_id !== 'string') return null;
	if (!isIdentity(value.from)) return null;
	const record = Object.create(null) as MessageRecord;
	record.message_id = value.message_id;
	record.log_id = value.log_id;
	record.room_id = value.room_id;
	record.from = cloneJson(value.from);
	if (Object.hasOwn(value, 'body')) record.body = cloneJson(value.body) as MessageBody;
	const embedded: MessageRecord[] = [];
	if (Object.hasOwn(value, 'reply_to')) {
		const reference = toMessageRef(value.reply_to);
		if (reference) {
			record.reply_to = reference;
			if (isJsonObject(value.reply_to) && Object.hasOwn(value.reply_to, 'log_id')) {
				const snapshot = decodeMessage(value.reply_to);
				if (snapshot) embedded.push(snapshot.record, ...snapshot.embedded);
			}
		}
	}
	if (Object.hasOwn(value, 'deleted')) record.deleted = cloneJson(value.deleted) as boolean;
	if (Object.hasOwn(value, 'ext')) record.ext = cloneJson(value.ext) as JsonObject;
	return { record, embedded };
}

/**
 * Decode a room record (a `room_list` or `room_update` element, or a history
 * `rooms` element). Delivery fields are returned separately.
 */
export function decodeRoom(value: unknown): { record: RoomRecord; embedded: MessageRecord[]; delivery: RoomDelivery } | null {
	if (!isJsonObject(value) || typeof value.room_id !== 'string') return null;
	const record = Object.create(null) as RoomRecord;
	record.room_id = value.room_id;
	if (isLogId(value.log_id)) record.log_id = value.log_id;
	if (Object.hasOwn(value, 'parent_room_id') && typeof value.parent_room_id === 'string') record.parent_room_id = value.parent_room_id;
	if (Object.hasOwn(value, 'title')) record.title = cloneJson(value.title) as string;
	const embedded: MessageRecord[] = [];
	if (Object.hasOwn(value, 'intro_message')) {
		const reference = toMessageRef(value.intro_message);
		if (reference) {
			record.intro_message = reference;
			if (isJsonObject(value.intro_message) && Object.hasOwn(value.intro_message, 'log_id')) {
				const snapshot = decodeMessage(value.intro_message);
				if (snapshot) embedded.push(snapshot.record, ...snapshot.embedded);
			}
		}
	}
	if (Object.hasOwn(value, 'ext')) record.ext = cloneJson(value.ext) as JsonObject;
	const delivery: RoomDelivery = {};
	if (value.latest_log_id !== undefined && isLogId(value.latest_log_id)) delivery.latest_log_id = value.latest_log_id;
	if (value.history_log_id === null || isLogId(value.history_log_id)) delivery.history_log_id = value.history_log_id;
	if (Array.isArray(value.members)) delivery.members = value.members.filter(isIdentity).map((member) => cloneJson(member));
	return { record, embedded, delivery };
}

/**
 * The fields of a transient notice (§3.5, Appendix A.1): a `message`
 * notification without `message_id`, such as a `@private` command reply. It is
 * rendered for the session but never installed as a snapshot. Null when the
 * value has a `message_id` (a snapshot) or no valid `from`.
 */
export function decodeNotice(value: unknown): { room_id?: string; from: Identity; body?: MessageBody; ext?: JsonObject } | null {
	if (!isJsonObject(value) || value.message_id !== undefined || !isIdentity(value.from)) return null;
	return {
		...(typeof value.room_id === 'string' ? { room_id: value.room_id } : {}),
		from: cloneJson(value.from),
		...(isJsonObject(value.body) ? { body: cloneJson(value.body) as MessageBody } : {}),
		...(isJsonObject(value.ext) ? { ext: cloneJson(value.ext) } : {})
	};
}

/** Decode a `reactions` record into one reaction set per element (§4.5). */
export function decodeReactions(value: unknown): ReactionSet[] {
	if (!isJsonObject(value) || !isLogId(value.log_id) || !isLogId(value.message_id) || !Array.isArray(value.reactions)) return [];
	const sets: ReactionSet[] = [];
	for (const element of value.reactions) {
		if (!isJsonObject(element) || !isIdentity(element.from) || !Array.isArray(element.emojis)) continue;
		sets.push({
			log_id: value.log_id,
			message_id: value.message_id,
			...(typeof value.room_id === 'string' ? { room_id: value.room_id } : {}),
			from: cloneJson(element.from),
			emojis: [...new Set(element.emojis.filter(isString))]
		});
	}
	return sets;
}

/** Decode a `membership` record (a notification's params or a history element) into one entry per member (§4.3.2). */
export function decodeMembership(value: unknown): MembershipEntry[] {
	if (!isJsonObject(value) || !isLogId(value.log_id) || typeof value.room_id !== 'string' || !Array.isArray(value.members)) return [];
	const entries: MembershipEntry[] = [];
	for (const element of value.members) {
		if (!isJsonObject(element) || !isIdentity(element.user) || typeof element.joined !== 'boolean') continue;
		entries.push({ log_id: value.log_id, room_id: value.room_id, user: cloneJson(element.user), joined: element.joined });
	}
	return entries;
}
