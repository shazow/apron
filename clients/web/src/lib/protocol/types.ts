export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject | undefined;
export interface JsonObject {
	[key: string]: JsonValue;
}

export interface Identity extends JsonObject {
	user_id: string;
	name?: string;
	avatar?: string;
}

export interface MessageBody extends JsonObject {
	text?: string;
	format?: 'plain' | 'markdown' | string;
	embeds?: Embed[];
}

export interface Embed extends JsonObject {
	kind: string;
	url?: string;
	mime?: string;
	name?: string;
	size?: number;
	w?: number;
	h?: number;
}

export interface MessageRecord extends JsonObject {
	message_id: string;
	from: Identity;
	body?: MessageBody;
	reply_message_id?: string;
	thread_id?: string;
	deleted?: boolean;
}

export interface Transition {
	log_id: string;
	message: MessageRecord;
}

export interface ServerParams {
	protocol: number;
	name?: string;
	caps?: string[];
	auth: string[];
	upload?: string;
	extensions?: string[];
	demo?: DemoParams;
}

export interface DemoParams extends JsonObject {
	retention_seconds?: number;
	cleanup_seconds?: number;
	max_frame_bytes?: number;
	max_message_text_bytes?: number;
	max_snapshot_bytes?: number;
	anonymous_posts_per_minute?: number;
	registered_posts_per_minute?: number;
}

export interface RoomAnnouncement {
	room_id: string;
	name?: string;
	topic?: string;
	latest_id?: string;
	history_floor?: string;
	removed?: boolean;
}

export interface ThreadAnnouncement {
	room_id: string;
	thread_id: string;
	title?: string;
	summary?: string;
	root_message_id?: string;
}

export interface HistoryResult {
	entries: unknown[];
	first_id?: string;
	last_id?: string;
	more: boolean;
	history_floor?: string;
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

export function isMessageRecord(value: unknown): value is MessageRecord {
	return isJsonObject(value) && isLogId(value.message_id) &&
		isJsonObject(value.from) && typeof value.from.user_id === 'string';
}

export function toTransition(value: unknown): Transition | null {
	if (!isJsonObject(value) || !isLogId(value.log_id) || !isMessageRecord(value.message)) return null;
	return { log_id: value.log_id, message: value.message };
}

/** Log IDs are positive decimal strings; "0" is only an empty-log boundary. */
export function isLogId(value: unknown): value is string {
	return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}
