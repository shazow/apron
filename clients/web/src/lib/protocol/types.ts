/**
 * Wire types and decoders for Apron protocol v4 (PROTOCOL.md at the repository
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
export type Capability = 'history' | 'edit' | 'rooms' | 'reactions' | 'activity';

export interface Identity extends JsonObject {
	user_id: string;
	name?: string;
	avatar?: string;
}

export interface MessageBody extends JsonObject {
	text?: string;
	/** `plain` when absent (§3.5). */
	format?: 'plain' | 'markdown' | string;
	embeds?: Embed[];
}

/**
 * One entry of `body.embeds` (Appendix E). This client renders every kind as
 * the fallback card: the kind name, plus `url` or plain `text`.
 */
export interface Embed extends JsonObject {
	kind: string;
	url?: string;
	text?: string;
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

/** One user's complete emoji set on one message at one `log_id` (Appendix D.2). */
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
}

/** Delivery fields of a `room` frame (§3.4): this client's view, not logged. */
export interface RoomDelivery {
	latest_log_id?: string;
	history_log_id?: string | null;
	removed?: boolean;
}

export interface HistoryResult {
	rooms?: unknown[];
	entries: unknown[];
	reactions?: unknown[];
	first_id?: string;
	last_id?: string;
	more: boolean;
	latest_log_id: string;
	history_log_id: string | null;
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
 * Decode a room record (a `room` frame's params other than removals, or a
 * history `rooms` element). Delivery fields are returned separately.
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
	if (value.removed === true) delivery.removed = true;
	return { record, embedded, delivery };
}

/** Decode a `reactions` record into one reaction set per element (Appendix D.2). */
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
