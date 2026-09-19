export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject | undefined;
export interface JsonObject {
	[key: string]: JsonValue;
}

export interface Sender extends JsonObject {
	id: string;
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

export interface EventRecord extends JsonObject {
	event_id: string;
	sender?: Sender;
	body?: MessageBody | null;
	thread?: string;
	deleted?: boolean;
}

export interface CreationTransition {
	kind: 'creation';
	event: EventRecord;
}

export interface UpdateTransition {
	kind: 'update';
	event_id: string;
	target: string;
	set?: JsonObject;
	replace?: EventRecord;
}

export type Transition = CreationTransition | UpdateTransition;

export interface ServerParams {
	protocol: number;
	name?: string;
	caps?: string[];
	auth: string[];
	upload?: string;
}

export interface RoomAnnouncement {
	room: string;
	name?: string;
	topic?: string;
	latest_id?: string;
	removed?: boolean;
}

export interface ThreadAnnouncement {
	room: string;
	thread: string;
	name?: string;
	summary?: string;
	root?: string;
	removed?: boolean;
}

export interface HistoryResult {
	entries: unknown[];
	first_id?: string;
	last_id?: string;
	more: boolean;
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

export function isEventRecord(value: unknown): value is EventRecord {
	return isJsonObject(value) && isLogId(value.event_id);
}

export function isUpdateTransition(value: unknown): value is UpdateTransition {
	const hasSet = isJsonObject(value) && isJsonObject(value.set);
	const hasReplace = isJsonObject(value) && isEventRecord(value.replace);
	return (
		isJsonObject(value) &&
		isLogId(value.event_id) &&
		isLogId(value.target) &&
		(hasSet !== hasReplace) &&
		(!hasReplace || (value.replace as EventRecord).event_id === value.target)
	);
}

export function toTransition(value: unknown): Transition | null {
	if (!isJsonObject(value)) return null;
	if (isUpdateTransition(value)) {
		return {
			kind: 'update',
			event_id: value.event_id,
			target: value.target,
			...(isJsonObject(value.set) ? { set: value.set } : {}),
			...(isEventRecord(value.replace) ? { replace: value.replace } : {})
		};
	}
	if (isEventRecord(value)) return { kind: 'creation', event: value };
	return null;
}

/** Log IDs are positive decimal strings; "0" is only an empty-log boundary. */
export function isLogId(value: unknown): value is string {
	return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}
