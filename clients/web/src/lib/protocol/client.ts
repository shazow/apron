import { requestPasskey } from './webauthn';
import {
	ProtocolStore,
	compareLogIds,
	createTimeline,
	decodeHistoryRecords,
	timelineEvents,
	type DecodedRecords,
	type ReactionSummary,
	type TimelineState
} from './reducer';
import {
	cloneJson,
	decodeMessage,
	decodeReactions,
	decodeRoom,
	isIdentity,
	isJsonObject,
	isLogId,
	isString,
	type Capability,
	type Embed,
	type Identity,
	type JsonObject,
	type JsonValue,
	type MessageBody,
	type MessageRecord,
	type ReactionSet,
	type RoomRecord,
	type RpcError,
	type ServerExt,
	type ServerParams,
	type WireFrame
} from './types';

export type { ReactionSummary, TimelineState } from './reducer';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';
export type MessageFormat = 'plain' | 'markdown';

/**
 * One visible room (announced on this connection and not removed). Threads
 * are rooms with `parentRoomId` (PROTOCOL.md §3.4, Appendix C).
 */
export interface RoomSnapshot {
	id: string;
	/** Display title: the record's `title`, falling back to the `room_id`. */
	title: string;
	/** The stored room record (client fields plus `log_id`), without delivery fields. */
	record?: RoomRecord;
	/** Set for threads; fixed at creation. */
	parentRoomId?: string;
	/** The room's description or thread starter, as a message ID. */
	introMessageId?: string;
	/**
	 * The latest stored snapshot of the intro message (it may live in another
	 * room, usually the parent for a thread), when known.
	 */
	introMessage?: MessageRecord;
	/** Opaque extension data from the room record. */
	ext?: JsonObject;
	/** Greatest `log_id` known in the room's log. */
	latestLogId?: string;
	/** Advertised lower bound of retrievable history, `null` when none. */
	historyLogId?: string | null;
	/**
	 * Messages homed in this room with their aggregated reactions. While an
	 * automatic history recovery runs the published timeline is held (empty
	 * for a rebuild) and replaced when the recovery completes or fails.
	 */
	timeline: TimelineState;
	/** An automatic history recovery is running. */
	recovering: boolean;
	/** The last recovery or `loadRoom` failed; `loadRoom` retries. */
	recoveryError?: string;
	/**
	 * History for this room has been loaded on this connection: always true
	 * without cap `history`; for top-level rooms after the first recovery; for
	 * threads after `loadRoom` completed.
	 */
	loaded: boolean;
	/** A `loadRoom` request is in flight. */
	loading: boolean;
}

export interface PendingOperation {
	id: string;
	method: string;
	room?: string;
	messageId?: string;
	createdAt: number;
}

/** A typing indicator shown for another user (Appendix D.1). */
export interface TypingSnapshot {
	room: string;
	from: Identity;
}

export type Capabilities = Record<Capability, boolean>;

export interface ClientSnapshot {
	status: ConnectionStatus;
	/** True once the server has accepted this connection's auth request. */
	authenticated: boolean;
	authBusy?: boolean;
	passkeySession?: boolean;
	error?: string;
	server?: ServerParams;
	/** Which optional features the current `server` frame advertises (§4). */
	capabilities: Capabilities;
	you?: Identity;
	/** Visible rooms in announcement order (servers announce parents before threads). */
	rooms: RoomSnapshot[];
	activeRoom?: string;
	pending: PendingOperation[];
	typing: TypingSnapshot[];
	showReconnectDivider: boolean;
	/** Server supplied retry delay for the most recent temporary limit. */
	retryAfterMs?: number;
	/**
	 * When the transport dropped (or failed to open) while the client kept
	 * running; cleared once a connection authenticates again. The protocol
	 * state is rebuilt from the new connection, so a UI that wants to stay put
	 * holds its own copy of the last authenticated snapshot meanwhile.
	 */
	disconnectedAt?: number;
}

export interface OperationHandle<T extends JsonObject = JsonObject> {
	id: string;
	promise: Promise<T>;
}

export interface MessageResult extends JsonObject {
	message_id: string;
}

export interface RoomResult extends JsonObject {
	room_id: string;
}

export interface SendOptions {
	/** The message replied to; it may be in any room. */
	replyTo?: string;
	embeds?: Embed[];
	ext?: JsonObject;
}

/**
 * Changes to a saved message. Absent keys keep the latest snapshot's value;
 * `null` removes `reply_to` or `ext`. Saves always resubmit every client field
 * (Appendix B).
 */
export interface MessagePatch {
	room_id?: string;
	body?: MessageBody;
	reply_to?: string | null;
	ext?: JsonObject | null;
	deleted?: true;
}

export interface CreateRoomOptions {
	/** Creates a thread under this room. */
	parentRoomId?: string;
	title?: string;
	/** A bare reference to the room's description or the thread's starting message. */
	introMessageId?: string;
	ext?: JsonObject;
}

/**
 * Changes to a room's client fields. Absent keys keep the latest record's
 * value; `null` clears. `parent_room_id` is fixed at creation.
 */
export interface RoomPatch {
	title?: string | null;
	introMessageId?: string | null;
	ext?: JsonObject | null;
}

export interface ChatClientOptions {
	serverUrl: string;
	displayName?: string;
	onChange?: (snapshot: ClientSnapshot) => void;
}

interface RoomState {
	id: string;
	/** Known head: greatest `latest_log_id` or live record `log_id` for this room. */
	latestLogId?: string;
	historyLogId?: string | null;
	/** Effective lower bound F, monotonic; undefined until a bound is seen. */
	floor?: string;
	/** Checkpoint C of automatic recovery. */
	checkpoint?: string;
	recovery?: RecoveryState;
	recoveryGeneration: number;
	recoveryError?: string;
	/** Settled when the running (or next) automatic recovery completes or fails. */
	waiters: Array<{ resolve: () => void; reject: (error: Error) => void }>;
	/** Thread checkpoint T of `loadRoom`. */
	loadCheckpoint?: string;
	loadGeneration: number;
	loading: boolean;
	/** The published timeline; rebuilt from the store when dirty and not recovering. */
	timeline: TimelineState;
	dirty: boolean;
}

/** `embedded` marks a `reply_to`/`intro_message` snapshot, which installs regardless of its room's bound. */
type LiveRecord = { kind: 'message'; record: MessageRecord; embedded?: boolean } | { kind: 'reaction'; record: ReactionSet };

interface PendingSave {
	requestId: string;
	/** The submitted client fields (params without `message_id`/`room_id` key for rooms). */
	state: JsonObject;
	/** The stored record's `log_id` when the save was submitted. */
	baseLog?: string;
	/** The result arrived but no matching record yet: the next newer record settles it. */
	confirmed: boolean;
}

interface RecoveryState {
	/** Fixed H for the whole recovery. */
	head: string;
	/** Next position to request; undefined means from the start of the log. */
	nextAfter?: string;
	/**
	 * Live records for the room received during the recovery. They are applied
	 * to the store on arrival; the buffer bounds memory and lets a rebuild
	 * restore the ones at or above the new bound.
	 */
	buffer: LiveRecord[];
	bufferBytes: number;
	requestId?: string;
	generation: number;
}

interface PendingRequest<T extends JsonObject = JsonObject> {
	id: string;
	method: string;
	params: JsonObject;
	visible: boolean;
	allowBeforeAuth: boolean;
	createdAt: number;
	sentConnection?: number;
	timer: ReturnType<typeof setTimeout>;
	resolve: (result: T) => void;
	reject: (error: Error) => void;
}

interface TypingState {
	room: string;
	from: Identity;
	timer: ReturnType<typeof setTimeout>;
}

type ValidHistoryResponse = JsonObject & {
	entries: JsonValue[];
	more: boolean;
	latest_log_id: string;
	history_log_id: string | null;
};

const REQUEST_TIMEOUT_MS = 20_000;
const HISTORY_PAGE_SIZE = 200;
const MAX_RECONNECT_DELAY_MS = 60_000;
/** How long a typing indicator this client sends should persist without a refresh, in the `activity` frame's `typing` seconds. */
const TYPING_TIMEOUT_S = 15;
/** The longest a received typing indicator is shown without a refresh. */
const MAX_TYPING_S = 300;
/** How often the indicator is refreshed while typing continues: well inside the timeout, and far from one frame per keystroke. */
const TYPING_REFRESH_MS = 12_000;
const MAX_HISTORY_BUFFER_ENTRIES = 1_000;
const MAX_HISTORY_BUFFER_BYTES = 1_048_576;
const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;
/** The lowest possible log_id: the `after` bound when no lower bound is known. */
const FIRST_LOG_ID = '1';
const CAPABILITIES: Capability[] = ['history', 'edit', 'rooms', 'reactions', 'activity'];

/**
 * A browser-only Apron protocol v4 session; instantiate one per mounted UI.
 *
 * State model: one store of room records, message snapshots, and reaction
 * sets shared by every room (PROTOCOL.md §2), projected per visible room in
 * `snapshot().rooms`. Top-level rooms recover history automatically when
 * announced (cap `history`); threads are rooms with a parent and load their
 * history with `loadRoom` when opened. Mutations return an `OperationHandle`
 * that settles on the server's reply; the authoritative state arrives as
 * broadcasts, which may come before or after the reply.
 */
export class ChatClient {
	private readonly listeners = new Set<(snapshot: ClientSnapshot) => void>();
	private readonly store = new ProtocolStore();
	private readonly rooms = new Map<string, RoomState>();
	private readonly requests = new Map<string, PendingRequest>();
	private readonly typing = new Map<string, TypingState>();
	private readonly sentTypingAt = new Map<string, number>();
	/** Own reaction sets requested but not yet confirmed, per message. */
	private readonly reactionIntents = new Map<string, { requestId: string; emojis: string[] }>();
	/** Latest submitted client fields per message while a save is unconfirmed; later saves build on them. */
	private readonly pendingMessageSaves = new Map<string, PendingSave>();
	/** Latest submitted client fields per room while an update is unconfirmed. */
	private readonly pendingRoomSaves = new Map<string, PendingSave>();
	private socket?: WebSocket;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private connectionId = 0;
	private reconnectAttempt = 0;
	private running = false;
	private authenticated = false;
	private authRequested = false;
	private passkeyAbort?: AbortController;
	// Keep bearer credentials in memory, scoped to this server and mounted client.
	private sessionToken?: string;
	private passkeyRequired = false;
	private registeredSession = false;
	private activeRoomId?: string;
	private server?: ServerParams;
	private you?: Identity;
	private displayName = '';
	private status: ConnectionStatus = 'idle';
	private error?: string;
	private showReconnectDivider = false;
	private retryAfterUntil = 0;
	/** The server denied the connection as a whole (§1.1): no automatic reconnect until the user acts. */
	private reconnectHeld = false;
	/** The current socket carried an error about the connection; its message outlives the close. */
	private connectionErrored = false;
	private connectionProbe?: AbortController;
	private disconnectedAt?: number;

	constructor(private serverUrl: string, displayName = '') {
		this.displayName = displayName.trim();
		this.loadStoredSession();
	}

	static fromOptions(options: ChatClientOptions): ChatClient {
		const client = new ChatClient(options.serverUrl, options.displayName);
		if (options.onChange) client.subscribe(options.onChange);
		return client;
	}

	get url(): string {
		return this.serverUrl;
	}

	setUrl(serverUrl: string): void {
		const nextUrl = serverUrl.trim();
		if (!nextUrl || nextUrl === this.serverUrl) return;
		this.serverUrl = nextUrl;
		this.sessionToken = undefined;
		this.passkeyRequired = false;
		this.registeredSession = false;
		this.retryAfterUntil = 0;
		this.reconnectHeld = false;
		this.loadStoredSession();
		this.resetSession('Server URL changed; pending requests were cancelled');
		if (this.running) this.restart();
	}

	/**
	 * Sets the display name, sent with `auth` and as a `me` request (§3.3).
	 * When authenticated the request goes out at once and its handle is
	 * returned so the caller can show what the server actually kept (`you`).
	 */
	setDisplayName(displayName: string): OperationHandle | undefined {
		this.displayName = displayName.trim();
		if (this.authenticated && this.displayName) {
			return this.sendName();
		}
		return undefined;
	}

	private sendName(): OperationHandle {
		const request = this.enqueueRequest('me', { name: this.displayName }, {
			visible: false,
			allowBeforeAuth: false
		});
		request.promise
			.then((result) => {
				if (isJsonObject(result.you) && typeof result.you.user_id === 'string') this.setYou(result.you as Identity);
				this.emit();
			})
			.catch(() => {
				// A name is advisory; a server may decline it without affecting the session.
			});
		return request;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.reconnectHeld = false;
		this.showReconnectDivider = this.reconnectAttempt > 0;
		this.connectNow();
	}

	stop(): void {
		this.connectionProbe?.abort();
		this.cancelPasskey();
		this.running = false;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		const socket = this.socket;
		this.socket = undefined;
		this.authenticated = false;
		this.authRequested = false;
		this.clearTyping();
		for (const request of this.requests.values()) {
			clearTimeout(request.timer);
			request.reject(new Error('Connection stopped'));
		}
		this.requests.clear();
		if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, 'client stopped');
		this.status = 'offline';
		this.emit();
	}

	restart(): void {
		if (!this.running) return;
		this.connectionProbe?.abort();
		this.connectionId += 1;
		this.reconnectHeld = false;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.cancelPasskey();
		const socket = this.socket;
		this.socket = undefined;
		this.authenticated = false;
		this.authRequested = false;
		this.clearTransientRequests();
		this.discardProtocolView('Reconnecting');
		if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, 'reconnecting');
		this.disconnectedAt = undefined;
		this.status = 'reconnecting';
		this.scheduleReconnect(0);
		this.emit();
	}

	/**
	 * Skips the remaining backoff and reconnects at once, keeping the current
	 * session state. Meant for an explicit user action after a reconnect has
	 * stalled or the server denied the connection; the exponential backoff
	 * restarts from its shortest delay.
	 */
	retryNow(): void {
		if (!this.running) return;
		if (this.retryAfterRemaining()) {
			this.emit();
			return;
		}
		this.reconnectHeld = false;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.reconnectAttempt = 0;
		const socket = this.socket;
		if (socket) {
			// A socket that is open but never authenticated (or still opening) is
			// stuck; drop it and start over. Its close handler is ignored because
			// the connection id advances in connectNow.
			this.socket = undefined;
			this.cancelPasskey();
			this.authenticated = false;
			this.authRequested = false;
			this.clearTransientRequests();
			if (socket.readyState !== WebSocket.CLOSED) socket.close(1000, 'retrying');
		}
		this.disconnectedAt ??= Date.now();
		this.error = undefined;
		this.connectNow();
	}

	/** Selects the room (or thread) the UI shows; unknown rooms are ignored. */
	selectRoom(roomId: string): void {
		if (this.rooms.has(roomId)) {
			this.activeRoomId = roomId;
			this.emit();
		}
	}

	subscribe(listener: (snapshot: ClientSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot());
		return () => this.listeners.delete(listener);
	}

	snapshot(): ClientSnapshot {
		for (const roomId of this.store.takeTouched()) {
			const room = this.rooms.get(roomId);
			if (room) room.dirty = true;
		}
		const history = this.hasCap('history');
		return {
			status: this.status,
			authenticated: this.authenticated,
			authBusy: Boolean(this.passkeyAbort),
			passkeySession: Boolean(this.registeredSession && this.authenticated),
			error: this.error,
			server: this.server,
			capabilities: capabilitiesOf(this.server),
			you: this.you,
			rooms: [...this.rooms.values()].map((room) => {
				if (room.dirty && !room.recovery) {
					room.timeline = this.store.timeline(room.id, this.you?.user_id);
					room.dirty = false;
				}
				const record = this.store.room(room.id);
				const thread = typeof record?.parent_room_id === 'string';
				const intro = record?.intro_message ? this.store.message(record.intro_message.message_id) : undefined;
				return {
					id: room.id,
					title: typeof record?.title === 'string' && record.title ? record.title : room.id,
					...(record ? { record } : {}),
					...(thread ? { parentRoomId: record!.parent_room_id } : {}),
					...(record?.intro_message ? { introMessageId: record.intro_message.message_id } : {}),
					...(intro ? { introMessage: intro } : {}),
					...(record && isJsonObject(record.ext) ? { ext: record.ext } : {}),
					...(room.latestLogId !== undefined ? { latestLogId: room.latestLogId } : {}),
					...(room.historyLogId !== undefined ? { historyLogId: room.historyLogId } : {}),
					timeline: room.timeline,
					recovering: Boolean(room.recovery),
					...(room.recoveryError ? { recoveryError: room.recoveryError } : {}),
					loaded: !history || (thread ? room.loadCheckpoint !== undefined : room.checkpoint !== undefined),
					loading: room.loading
				};
			}),
			activeRoom: this.activeRoomId,
			pending: [...this.requests.values()]
				.filter((request) => request.visible)
				.map(({ id, method, params, createdAt }) => ({
					id,
					method,
					...(typeof params.room_id === 'string' ? { room: params.room_id } : {}),
					...(typeof params.message_id === 'string' ? { messageId: params.message_id } : {}),
					createdAt
				})),
			typing: [...this.typing.values()].map(({ room, from }) => ({ room, from })),
			showReconnectDivider: this.showReconnectDivider,
			retryAfterMs: this.retryAfterRemaining(),
			...(this.disconnectedAt !== undefined ? { disconnectedAt: this.disconnectedAt } : {})
		};
	}

	/**
	 * The latest stored snapshot of any message, in any room (including rooms
	 * that are not visible, such as a cross-room reply target or an embedded
	 * `intro_message`). Reflects live records immediately, even while the
	 * room's published timeline is held during a recovery.
	 */
	message(messageId: string): MessageRecord | undefined {
		return this.store.message(messageId);
	}

	/** The stored room record, visible or not. */
	roomRecord(roomId: string): RoomRecord | undefined {
		return this.store.room(roomId);
	}

	/** Aggregated reactions for a message (undefined for tombstones or none). */
	reactions(messageId: string): ReactionSummary[] | undefined {
		return this.store.reactions(messageId, this.you?.user_id);
	}

	/** Your own emoji set on a message, including a requested change not yet confirmed. */
	ownReactions(messageId: string): string[] {
		const intent = this.reactionIntents.get(messageId);
		if (intent) return [...intent.emojis];
		const you = this.you?.user_id;
		return you === undefined ? [] : [...(this.store.reactionSet(messageId, you)?.emojis ?? [])];
	}

	async usePasskey(action: 'register' | 'login'): Promise<void> {
		if (!this.server?.auth.includes('webauthn')) throw new Error('This server does not support passkeys');
		if (this.passkeyAbort || this.authRequested || this.requests.size) throw new Error('Wait for pending requests to finish, then try again');
		if (this.status !== 'connected') throw new Error('Connect to the server first');
		const controller = new AbortController();
		this.passkeyAbort = controller;
		const connection = this.connectionId;
		this.emit();
		try {
			const begin = { scheme: 'webauthn', action, step: 'begin' };
			const options = await this.passkeyRequest(begin);
			const challengeId = typeof options.challenge_id === 'string' && options.challenge_id.length > 0
				? options.challenge_id : undefined;
			if (!challengeId) throw new Error('Passkey challenge was missing; try again');
			if (!isJsonObject(options.public_key)) throw new Error('Passkey options were missing; try again');
			const credential = await requestPasskey(action, options, controller.signal);
			if (controller.signal.aborted || connection !== this.connectionId) throw new Error('Connection changed; try again');
			const finish = { scheme: 'webauthn', action, step: 'finish', challenge_id: challengeId, credential };
			const result = await this.passkeyRequest(finish);
			if (controller.signal.aborted || connection !== this.connectionId) throw new Error('Connection changed; try again');
			this.cancelPasskey();
			if (!this.handleAuth(result, true)) throw new Error('Server authentication response did not include an identity');
		} finally {
			if (this.passkeyAbort === controller) this.cancelPasskey();
			this.emit();
		}
	}

	async signOut(): Promise<void> {
		if (this.passkeyAbort || this.requests.size) throw new Error('Wait for pending requests to finish, then try again');
		this.sessionToken = undefined;
		this.storeSession(undefined);
		this.passkeyRequired = false;
		this.registeredSession = false;
		this.resetSession('Signed out');
		this.restart();
	}

	private passkeyRequest(params: JsonObject): Promise<JsonObject> {
		return this.enqueueRequest('auth', params, {
			visible: false, allowBeforeAuth: true
		}).promise;
	}

	private cancelPasskey(): void {
		this.passkeyAbort?.abort(new DOMException('Connection changed; try again', 'AbortError'));
		this.passkeyAbort = undefined;
	}

	/**
	 * Posts a message (§3.5). `format` defaults to `plain`; `replyTo` names a
	 * message in any room and is sent as a bare reference.
	 */
	send(room: string, text: string, format: MessageFormat = 'plain', options: SendOptions = {}): OperationHandle<MessageResult> {
		const body: JsonObject = { text, format };
		if (options.embeds && options.embeds.length > 0) body.embeds = options.embeds;
		return this.enqueueRequest<MessageResult>('message', {
			room_id: room,
			body,
			...(options.replyTo !== undefined ? { reply_to: { message_id: options.replyTo } } : {}),
			...(options.ext !== undefined ? { ext: options.ext } : {})
		}, { visible: true, allowBeforeAuth: false });
	}

	/**
	 * Saves a message (cap `edit`, Appendix B) from its latest stored snapshot:
	 * every client field (`room_id`, `body`, bare `reply_to`, `ext`) is
	 * resubmitted unless the patch changes it. `deleted: true` omits `body`.
	 */
	saveMessage(messageId: string, patch: MessagePatch = {}): OperationHandle<MessageResult> {
		const current = this.messageBase(messageId);
		if (!current) return rejectedHandle('message', new Error('Message has not been loaded'));
		const params: JsonObject = { message_id: messageId, room_id: patch.room_id ?? current.room_id };
		// A tombstone stays a tombstone: saving it (a move, a reply change) resubmits `deleted`.
		if (patch.deleted || current.deleted === true) {
			params.deleted = true;
		} else if (patch.body !== undefined) {
			params.body = patch.body;
		} else if (current.body !== undefined) {
			params.body = current.body;
		}
		if (patch.reply_to === undefined) {
			if (isJsonObject(current.reply_to) && typeof current.reply_to.message_id === 'string') params.reply_to = { message_id: current.reply_to.message_id };
		} else if (patch.reply_to !== null) {
			params.reply_to = { message_id: patch.reply_to };
		}
		if (patch.ext === undefined) {
			if (current.ext !== undefined) params.ext = current.ext;
		} else if (patch.ext !== null) {
			params.ext = patch.ext;
		}
		const handle = this.enqueueRequest<MessageResult>('message', params, { visible: true, allowBeforeAuth: false });
		const { message_id: _id, ...state } = params;
		this.trackSave(this.pendingMessageSaves, messageId, handle, state, () => this.store.message(messageId)?.log_id);
		return handle;
	}

	/**
	 * The client fields a save builds on: the latest submitted state while an
	 * earlier save of the message is unconfirmed, otherwise the stored snapshot.
	 */
	private messageBase(messageId: string): JsonObject | undefined {
		const pending = this.pendingMessageSaves.get(messageId);
		if (pending) return pending.state;
		const current = this.store.message(messageId);
		return current ? messageClientFields(current) : undefined;
	}

	private trackSave(
		pending: Map<string, PendingSave>, key: string, handle: OperationHandle, state: JsonObject, latestLog: () => string | undefined
	): void {
		const baseLog = latestLog();
		pending.set(key, { requestId: handle.id, state, ...(baseLog !== undefined ? { baseLog } : {}), confirmed: false });
		const current = () => pending.get(key)?.requestId === handle.id ? pending.get(key) : undefined;
		handle.promise.then(() => {
			const entry = current();
			if (!entry) return;
			const log = latestLog();
			// A newer record already arrived (the server may normalize what it stored).
			if (log !== undefined && (entry.baseLog === undefined || compareLogIds(log, entry.baseLog) > 0)) pending.delete(key);
			else entry.confirmed = true;
		}, () => {
			if (current()) pending.delete(key);
		});
	}

	/** Settle a pending save when a newer record arrives that matches it, or after its result. */
	private settleSave(pending: Map<string, PendingSave>, key: string, fields: JsonObject): void {
		const entry = pending.get(key);
		if (!entry) return;
		if (entry.confirmed || canonicalJson(fields) === canonicalJson(entry.state)) pending.delete(key);
	}

	private installMessage(record: MessageRecord): void {
		if (this.store.putMessage(record)) this.settleSave(this.pendingMessageSaves, record.message_id, messageClientFields(record));
	}

	private installRoom(record: RoomRecord): void {
		if (this.store.putRoom(record)) this.settleSave(this.pendingRoomSaves, record.room_id, roomClientFields(record));
	}

	/** Replaces the text (and optionally the format) and keeps every other body key. */
	editMessage(messageId: string, text: string, format?: MessageFormat): OperationHandle<MessageResult> {
		const current = this.messageBase(messageId);
		const body: MessageBody = { ...(isJsonObject(current?.body) ? current.body : {}), text, ...(format ? { format } : {}) };
		return this.saveMessage(messageId, { body });
	}

	/** Moves a message to another room (for example into a thread); the server delivers the snapshot to both. */
	moveMessage(messageId: string, roomId: string): OperationHandle<MessageResult> {
		return this.saveMessage(messageId, { room_id: roomId });
	}

	/** Replaces the message with a tombstone. */
	deleteMessage(messageId: string): OperationHandle<MessageResult> {
		return this.saveMessage(messageId, { deleted: true });
	}

	/** Sets or (with `null`) removes the message's `reply_to`. */
	setMessageReply(messageId: string, replyTo: string | null): OperationHandle<MessageResult> {
		return this.saveMessage(messageId, { reply_to: replyTo });
	}

	/**
	 * Sets your complete emoji set on a message (cap `reactions`, Appendix
	 * D.2); `[]` clears it. The result is `{}`; the broadcast carries the state.
	 */
	react(messageId: string, emojis: string[]): OperationHandle {
		const request = this.enqueueRequest('reactions', { message_id: messageId, emojis: [...emojis] }, {
			visible: true, allowBeforeAuth: false
		});
		const intent = { requestId: request.id, emojis: [...new Set(emojis)] };
		this.reactionIntents.set(messageId, intent);
		// The intent stays until a broadcast of the same set, or until the result
		// when the store already matches (a server that logged no change), or an
		// error, or a disconnect.
		request.promise.then(() => {
			if (this.reactionIntents.get(messageId) !== intent) return;
			const you = this.you?.user_id;
			const stored = you === undefined ? [] : this.store.reactionSet(messageId, you)?.emojis ?? [];
			if (sameEmojiSet(stored, intent.emojis)) this.reactionIntents.delete(messageId);
		}, () => {
			if (this.reactionIntents.get(messageId) === intent) this.reactionIntents.delete(messageId);
		}).finally(() => this.emit());
		return request;
	}

	/** Adds the emoji to your set on the message, or removes it when present. */
	toggleReaction(messageId: string, emoji: string): OperationHandle {
		const current = this.ownReactions(messageId);
		const next = current.includes(emoji) ? current.filter((entry) => entry !== emoji) : [...current, emoji];
		return this.react(messageId, next);
	}

	/**
	 * Creates a room (cap `rooms`, Appendix C); with `parentRoomId` it is a
	 * thread, usually with the parent message that started it as
	 * `introMessageId`. Resolves with the new `room_id`; the room record is
	 * announced separately.
	 */
	createRoom(options: CreateRoomOptions = {}): OperationHandle<RoomResult> {
		const params: JsonObject = {};
		if (options.parentRoomId !== undefined) params.parent_room_id = options.parentRoomId;
		if (options.title !== undefined) params.title = options.title;
		if (options.introMessageId !== undefined) params.intro_message = { message_id: options.introMessageId };
		if (options.ext !== undefined) params.ext = options.ext;
		return this.enqueueRequest<RoomResult>('room', params, { visible: true, allowBeforeAuth: false });
	}

	/**
	 * Updates a room's client fields from its latest record with the patch
	 * applied, resubmitting `title`, a bare `intro_message`, and `ext`.
	 */
	updateRoom(roomId: string, patch: RoomPatch): OperationHandle<RoomResult> {
		// Build on the latest submitted update while one is unconfirmed.
		const stored = this.store.room(roomId);
		const current = this.pendingRoomSaves.get(roomId)?.state ?? (stored ? roomClientFields(stored) : {});
		const params: JsonObject = { room_id: roomId };
		const title = patch.title === undefined ? current.title : patch.title;
		if (title !== undefined && title !== null) params.title = title;
		const currentIntro = isJsonObject(current.intro_message) && typeof current.intro_message.message_id === 'string'
			? current.intro_message.message_id : undefined;
		const intro = patch.introMessageId === undefined ? currentIntro : patch.introMessageId;
		if (intro !== undefined && intro !== null) params.intro_message = { message_id: intro };
		const ext = patch.ext === undefined ? current.ext : patch.ext;
		if (ext !== undefined && ext !== null) params.ext = ext;
		const handle = this.enqueueRequest<RoomResult>('room', params, { visible: true, allowBeforeAuth: false });
		const { room_id: _id, ...state } = params;
		this.trackSave(this.pendingRoomSaves, roomId, handle, state, () => this.store.room(roomId)?.log_id);
		return handle;
	}

	/** `room_join`: the server re-announces the room on success. */
	joinRoom(roomId: string): OperationHandle {
		return this.enqueueRequest('room_join', { room_id: roomId }, { visible: true, allowBeforeAuth: false });
	}

	/** `room_leave`: the server announces the room as removed on success. */
	leaveRoom(roomId: string): OperationHandle {
		return this.enqueueRequest('room_leave', { room_id: roomId }, { visible: true, allowBeforeAuth: false });
	}

	/**
	 * Reports typing in a room as an `activity` notification (cap `activity`,
	 * Appendix D.1): `typing` seconds while active, `0` to stop. Sends nothing
	 * to a server without the cap.
	 */
	sendTyping(room: string, active: boolean): void {
		if (!this.authenticated || !this.hasCap('activity') || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
		const previous = this.sentTypingAt.get(room);
		const now = Date.now();
		// Refresh well inside the advertised lifetime, not on every keypress.
		// Repeated inactive events do not need another notification either.
		if (active) {
			if (previous !== undefined && now - previous < TYPING_REFRESH_MS) return;
			this.sentTypingAt.set(room, now);
		} else {
			if (previous === undefined) return;
			this.sentTypingAt.delete(room);
		}
		this.sendFrame({ method: 'activity', params: { room_id: room, typing: active ? TYPING_TIMEOUT_S : 0 } });
	}

	/**
	 * Loads a room's history (Appendix A). Threads never recover
	 * automatically: call this when one is opened. It pages from the room's
	 * lower bound (or its previous load's checkpoint) up to the head known at
	 * the call, and resolves after the last page. For a top-level room, which
	 * recovers automatically, it waits for the running recovery, or retries one
	 * that failed. Without cap `history` it resolves at once.
	 */
	loadRoom(roomId: string): Promise<void> {
		const room = this.rooms.get(roomId);
		if (!room) return Promise.reject(new Error('Unknown room'));
		if (!this.hasCap('history')) return Promise.resolve();
		if (!this.isThread(room.id)) {
			const head = room.latestLogId;
			const needed = Boolean(room.recovery) || Boolean(head && (room.recoveryError || room.checkpoint === undefined || compareLogIds(head, room.checkpoint) > 0));
			if (!needed) return Promise.resolve();
			const settled = new Promise<void>((resolve, reject) => room.waiters.push({ resolve, reject }));
			if (!room.recovery && head) {
				this.startRecovery(room, head, Boolean(room.recoveryError) || room.checkpoint === undefined);
				this.emit();
			}
			return settled;
		}
		return this.loadThread(room);
	}

	private async loadThread(room: RoomState): Promise<void> {
		const head = room.latestLogId;
		if (!head) return;
		const generation = ++room.loadGeneration;
		const stale = () => this.rooms.get(room.id) !== room || room.loadGeneration !== generation;
		room.loading = true;
		room.recoveryError = undefined;
		this.emit();
		try {
			let checkpoint = room.loadCheckpoint;
			let after: string | undefined = maxDefined(checkpoint === undefined ? undefined : increment(checkpoint), room.floor) ?? FIRST_LOG_ID;
			while (after === undefined || compareLogIds(after, head) <= 0) {
				const result = await this.enqueueRequest('history', historyParams(room.id, after, head), {
					visible: false, allowBeforeAuth: false
				}).promise;
				if (stale()) return;
				if (!validHistoryMetadata(result)) throw new Error('Invalid history response');
				this.observeHistoryResponse(room, result);
				if (stale()) return;
				if (after !== undefined && room.floor !== undefined && compareLogIds(room.floor, after) > 0) {
					// History was discarded underneath this load: continue from the bound.
					after = room.floor;
					continue;
				}
				this.applyPage(room, result);
				if (!result.more) {
					checkpoint = maxDefined(checkpoint, head);
					room.loadCheckpoint = checkpoint;
					return;
				}
				const lastId = result.last_id;
				if (!isLogId(lastId) || (after !== undefined && compareLogIds(lastId, after) < 0) || compareLogIds(lastId, head) >= 0) {
					throw new Error('Invalid history continuation');
				}
				after = increment(lastId);
				checkpoint = maxDefined(checkpoint, lastId);
				room.loadCheckpoint = checkpoint;
			}
			room.loadCheckpoint = maxDefined(checkpoint, head);
		} catch (cause) {
			if (!stale()) room.recoveryError = cause instanceof Error ? cause.message : 'History failed';
			throw cause;
		} finally {
			if (!stale()) room.loading = false;
			this.emit();
		}
	}

	private connectNow(): void {
		if (!this.running || this.socket) return;
		this.connectionProbe?.abort();
		const id = ++this.connectionId;
		let opened = false;
		this.status = this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting';
		this.error = undefined;
		this.connectionErrored = false;
		this.emit();
		let socket: WebSocket;
		try {
			socket = new WebSocket(this.serverUrl);
		} catch (cause) {
			this.handleConnectionFailure(id, cause instanceof Error ? cause.message : 'Unable to open WebSocket');
			return;
		}
		this.socket = socket;
		socket.onopen = () => {
			if (!this.isCurrentSocket(id, socket)) return;
			opened = true;
			this.status = 'connected';
			this.error = undefined;
			this.authRequested = false;
			this.emit();
		};
		socket.onmessage = (event) => {
			if (!this.isCurrentSocket(id, socket)) return;
			this.handleMessage(event.data);
		};
		socket.onerror = () => {
			if (this.isCurrentSocket(id, socket) && !this.connectionErrored) this.error = 'WebSocket connection error';
			this.emit();
		};
		socket.onclose = () => {
			if (!this.isCurrentSocket(id, socket)) return;
			this.cancelPasskey();
			this.showReconnectDivider = this.rooms.size > 0 || this.showReconnectDivider;
			this.socket = undefined;
			this.authenticated = false;
			this.authRequested = false;
			this.clearTransientRequests();
			this.clearTyping();
			// The protocol view is rebuilt from the next connection's announcements
			// (PROTOCOL.md §3.4; see tests/fixtures/wire/session). The UI keeps the
			// last authenticated view on screen meanwhile, keyed off disconnectedAt.
			this.discardProtocolView('Connection closed');
			if (this.running) {
				this.disconnectedAt ??= Date.now();
				this.status = 'reconnecting';
				if (opened) this.scheduleReconnect();
				else void this.diagnoseConnection(id);
			} else {
				this.status = 'offline';
			}
			this.emit();
		};
	}

	private async diagnoseConnection(id: number): Promise<void> {
		const controller = new AbortController();
		this.connectionProbe = controller;
		const timeout = setTimeout(() => controller.abort(), 4_000);
		try {
			const url = new URL(this.serverUrl);
			url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
			url.searchParams.set('apron_connection_status', '1');
			const response = await fetch(url, {
				credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal
			});
			if (![403, 429, 503].includes(response.status) || !response.headers.get('content-type')?.includes('application/json')) return;
			const body: unknown = await response.json();
			if (!this.running || id !== this.connectionId || controller.signal.aborted) return;
			if (!isJsonObject(body) || typeof body.error !== 'string' || !body.error.trim()) return;
			this.error = body.error.slice(0, 300);
			const retry = response.headers.get('Retry-After');
			if (retry) {
				const delay = /^\d+$/.test(retry) ? Number(retry) * 1_000 : Date.parse(retry) - Date.now();
				if (Number.isFinite(delay) && delay > 0) {
					this.retryAfterUntil = Math.max(this.retryAfterUntil, Date.now() + Math.min(delay, RETRY_AFTER_MAX_MS));
				}
			}
		} catch {
			// Servers without the status probe and network failures expose no HTTP diagnostics.
		} finally {
			clearTimeout(timeout);
			if (this.connectionProbe === controller) this.connectionProbe = undefined;
			if (this.running && id === this.connectionId) {
				this.scheduleReconnect();
				this.emit();
			}
		}
	}

	private handleMessage(raw: unknown): void {
		let value: unknown;
		try {
			value = typeof raw === 'string' ? JSON.parse(raw) : raw;
		} catch {
			this.error = 'The server sent invalid JSON';
			this.emit();
			return;
		}
		if (!isJsonObject(value)) return;
		const frame = value as WireFrame;
		switch (frame.method) {
			case 'server':
				this.handleServer(frame.params);
				return;
			case 'room':
				this.handleRoom(frame.params);
				return;
			case 'message':
				this.handleSnapshot(frame.params);
				return;
			case 'reactions':
				this.handleReactions(frame.params);
				return;
			case 'activity':
				this.handleActivity(frame.params);
				return;
		}
		if (frame.method !== undefined) return;
		if (typeof frame.id === 'string' && (frame.result !== undefined || frame.error !== undefined)) {
			this.handleResponse(frame.id, isJsonObject(frame.result) ? frame.result : {}, frame.error);
		} else if (frame.id === undefined || frame.id === null) {
			// An error without `id` is not tied to a request (§1.1); v3 servers sent `id: null`.
			if (isJsonObject(frame.error)) this.handleConnectionError(frame.error);
		}
	}

	/**
	 * An error about the connection as a whole, or a request the server could
	 * not identify (§1.1). The server may close the connection after it; the
	 * client acts on the code: `retry_after` delays the next reconnect, and
	 * `denied` stops reconnecting until the user retries.
	 */
	private handleConnectionError(rpcError: RpcError): void {
		const retryAfter = retryAfterMilliseconds(rpcError);
		if (retryAfter !== undefined) this.retryAfterUntil = Math.max(this.retryAfterUntil, Date.now() + retryAfter);
		if (rpcError.code === -32001) this.reconnectHeld = true;
		this.connectionErrored = true;
		this.error = (typeof rpcError.message === 'string' && rpcError.message.trim()
			? rpcError.message : `Connection error (${rpcError.code})`).slice(0, 300);
		this.emit();
	}

	private handleServer(params: JsonObject | undefined): void {
		if (!params || typeof params.protocol !== 'number' || !Array.isArray(params.auth)) return;
		const auth = params.auth.filter(isString);
		if (!auth.length) return;
		this.server = {
			protocol: params.protocol,
			...(typeof params.name === 'string' ? { name: params.name } : {}),
			caps: Array.isArray(params.caps) ? params.caps.filter(isString) : [],
			auth,
			...(isJsonObject(params.ext) ? { ext: params.ext as ServerExt } : {})
		};
		if (this.authenticated || this.authRequested) {
			this.emit();
			return;
		}
		const resume = Boolean(this.sessionToken && auth.includes('token'));
		if (!resume && this.passkeyRequired && auth.includes('webauthn')) {
			// Servers without bearer-token resume still need discoverable login after
			// a transport reconnect so a registered user keeps the server identity.
			this.authRequested = true;
			const socket = this.socket;
			queueMicrotask(() => {
				if (socket !== this.socket || !this.authRequested) return;
				this.authRequested = false;
				this.usePasskey('login').catch((cause: Error) => {
					if (socket !== this.socket) return;
					this.error = cause.message;
					this.emit();
				});
			});
			this.emit();
			return;
		}
		if (!resume && (this.passkeyRequired || !auth.includes('guest'))) {
			this.error = auth.includes('webauthn') ? 'Sign in with a passkey from your profile.' : 'No supported authentication scheme';
			this.emit();
			return;
		}
		this.authRequested = true;
		const socket = this.socket;
		const request = this.enqueueRequest('auth', {
			...(resume ? { scheme: 'token', token: this.sessionToken } : { scheme: 'guest' }),
			client: 'apron-web/0.2'
		}, { visible: false, allowBeforeAuth: true });
		request.promise.then((result) => {
			if (socket === this.socket) this.handleAuth(result);
		}).catch((cause: Error) => {
			if (socket !== this.socket) return;
			this.authRequested = false;
			// Never silently downgrade a passkey session to a different guest identity.
			if (resume) {
				this.sessionToken = undefined;
				this.storeSession(undefined);
			}
			this.error = cause.message;
			this.emit();
		});
	}

	private handleAuth(result: JsonObject, passkey = false): boolean {
		const identity = result.you;
		if (!isJsonObject(identity) || typeof identity.user_id !== 'string') {
			this.error = 'Server authentication response did not include an identity';
			this.emit();
			return false;
		}
		this.setYou(identity as Identity);
		if (passkey) {
			this.passkeyRequired = true;
			this.registeredSession = true;
		}
		if (typeof result.token === 'string') {
			this.sessionToken = result.token;
			this.passkeyRequired = true;
			this.registeredSession = true;
			// Persist only when the server can actually resume with it, so a reload
			// against a ceremony-only server does not turn into an unprompted
			// passkey request at load time.
			if (this.server?.auth.includes('token')) this.storeSession(result.token);
		}
		this.error = undefined;
		this.retryAfterUntil = 0;
		this.authenticated = true;
		this.authRequested = false;
		this.reconnectAttempt = 0;
		this.disconnectedAt = undefined;
		// A reconnect drops the store, and a server with cap `history` gives it all
		// back through recovery; only a session-only scrollback (§4 fallback) has a
		// real gap to mark.
		this.showReconnectDivider = (this.showReconnectDivider || this.rooms.size > 0) && !this.hasCap('history');
		// Requests queued while this connection was authenticating go out now.
		for (const request of this.requests.values()) this.sendRequest(request);
		if (this.displayName) this.sendName();
		this.emit();
		return true;
	}

	private setYou(identity: Identity): void {
		const changed = this.you?.user_id !== identity.user_id;
		this.you = identity;
		// `mine` in every reaction summary depends on the viewer.
		if (changed) for (const room of this.rooms.values()) room.dirty = true;
	}

	private hasCap(cap: Capability): boolean {
		return this.server?.caps?.includes(cap) === true;
	}

	private isThread(roomId: string): boolean {
		return typeof this.store.room(roomId)?.parent_room_id === 'string';
	}

	/** Automatic recovery applies to top-level rooms when the server keeps history. */
	private recoversAutomatically(room: RoomState): boolean {
		return this.hasCap('history') && !this.isThread(room.id);
	}

	private handleRoom(params: JsonObject | undefined): void {
		if (!params || typeof params.room_id !== 'string') return;
		const roomId = params.room_id;
		if (params.removed === true) {
			const room = this.rooms.get(roomId);
			if (room) this.discardRoom(room, 'Room removed');
			this.rooms.delete(roomId);
			if (this.activeRoomId === roomId) this.activeRoomId = this.defaultRoomId();
			this.emit();
			return;
		}
		const decoded = decodeRoom(params);
		if (!decoded) return;
		this.installRoom(decoded.record);
		const existing = this.rooms.get(roomId);
		const room: RoomState = existing ?? {
			id: roomId,
			recoveryGeneration: 0,
			waiters: [],
			loadGeneration: 0,
			loading: false,
			timeline: createTimeline(roomId),
			dirty: true
		};
		this.rooms.set(roomId, room);
		const announcedHead = decoded.delivery.latest_log_id;
		this.observeHead(room, announcedHead);
		// Record the head before the bound so a new recovery captures it. An
		// active recovery keeps its original fixed head.
		if (Object.hasOwn(decoded.delivery, 'history_log_id')) {
			this.observeBoundary(room, decoded.delivery.history_log_id, announcedHead ?? room.latestLogId);
		}
		if (!decoded.record.parent_room_id) this.activeRoomId ??= roomId;
		const head = room.latestLogId;
		if (this.recoversAutomatically(room) && !room.recovery && head !== undefined) {
			const rebuild = !existing || Boolean(room.recoveryError) || room.checkpoint === undefined;
			if (rebuild || compareLogIds(head, room.checkpoint!) > 0) this.startRecovery(room, head, rebuild);
		}
		// Embedded snapshots install after the bound and any rebuild, so neither drops them.
		for (const message of decoded.embedded) this.acceptLiveMessage(message, false);
		this.emit();
	}

	private handleSnapshot(params: JsonObject | undefined): void {
		const decoded = decodeMessage(params);
		if (!decoded) return;
		this.acceptLiveMessage(decoded.record, true);
		for (const embedded of decoded.embedded) this.acceptLiveMessage(embedded, false);
		// A new message from a user ends their typing indicator in that room (Appendix D.1).
		if (decoded.record.log_id === decoded.record.message_id) this.removeTyping(decoded.record.room_id, decoded.record.from.user_id);
		this.emit();
	}

	private handleReactions(params: JsonObject | undefined): void {
		const sets = decodeReactions(params);
		if (!sets.length) return;
		const room = sets[0].room_id !== undefined ? this.rooms.get(sets[0].room_id) : undefined;
		if (room) {
			if (room.floor !== undefined && compareLogIds(sets[0].log_id, room.floor) < 0) return;
			this.observeHead(room, sets[0].log_id);
		}
		for (const set of sets) {
			if (room?.recovery && !this.bufferLive(room, { kind: 'reaction', record: set })) return;
			this.store.putReaction(set);
			if (set.from.user_id === this.you?.user_id) {
				const intent = this.reactionIntents.get(set.message_id);
				if (intent && sameEmojiSet(set.emojis, intent.emojis)) this.reactionIntents.delete(set.message_id);
			}
		}
		this.emit();
	}

	/**
	 * Install a live message record. Records for a visible room below its
	 * bound are dropped; during the room's recovery they are also buffered.
	 * Records for rooms that are not visible still install, so a move out of a
	 * visible room re-homes the message instead of leaving a stale copy.
	 */
	private acceptLiveMessage(record: MessageRecord, delivered: boolean): void {
		const room = this.rooms.get(record.room_id);
		if (room) {
			// Embedded reference snapshots are not live records of their room: they
			// install regardless of its bound.
			if (delivered && room.floor !== undefined && compareLogIds(record.log_id, room.floor) < 0) return;
			if (delivered) this.observeHead(room, record.log_id);
			if (room.recovery && !this.bufferLive(room, { kind: 'message', record, embedded: !delivered })) return;
		}
		this.installMessage(record);
	}

	/** Returns false when the buffer overflowed and the recovery was restarted. */
	private bufferLive(room: RoomState, live: LiveRecord): boolean {
		const recovery = room.recovery!;
		if (!recoveryBufferFits(recovery.buffer.length, recovery.bufferBytes, live.record)) {
			this.restartRecoveryAfterOverflow(room);
			return false;
		}
		recovery.buffer.push(live);
		recovery.bufferBytes += recordBytes(live.record);
		return true;
	}

	private startRecovery(room: RoomState, head: string, rebuild: boolean, preserveBuffer = false): void {
		const retained = preserveBuffer
			? (room.recovery?.buffer ?? []).filter((live) => isEmbedded(live) || room.floor === undefined || compareLogIds(live.record.log_id, room.floor) >= 0)
			: [];
		this.retireRecoveryRequest(room);
		const generation = ++room.recoveryGeneration;
		if (rebuild) {
			this.store.clearRoom(room.id);
			for (const live of retained) this.applyLive(live);
			room.timeline = createTimeline(room.id);
		}
		// Without a known bound, start at the lowest possible log_id.
		const nextAfter = (rebuild
			? room.floor
			: maxDefined(room.checkpoint === undefined ? undefined : increment(room.checkpoint), room.floor)) ?? FIRST_LOG_ID;
		room.recovery = {
			head,
			nextAfter,
			buffer: retained,
			bufferBytes: retained.reduce((bytes, live) => bytes + recordBytes(live.record), 0),
			generation
		};
		room.recoveryError = undefined;
		if (nextAfter !== undefined && compareLogIds(nextAfter, head) > 0) {
			this.finishRecovery(room);
			return;
		}
		this.requestHistoryPage(room, generation);
	}

	private requestHistoryPage(room: RoomState, generation: number): void {
		const recovery = room.recovery;
		if (!recovery || recovery.generation !== generation || !this.authenticated) return;
		const request = this.enqueueRequest('history', historyParams(room.id, recovery.nextAfter, recovery.head), {
			visible: false, allowBeforeAuth: false
		});
		recovery.requestId = request.id;
		request.promise.then((result) => {
			if (room.recovery?.requestId !== request.id || room.recovery.generation !== generation) return;
			this.applyHistoryPage(room, result, generation);
		}).catch((cause: Error) => {
			if (!room.recovery || room.recovery.requestId !== request.id || room.recovery.generation !== generation) return;
			this.abortRecovery(room, cause.message);
		});
	}

	private applyHistoryPage(room: RoomState, result: JsonObject, generation: number): void {
		const recovery = room.recovery;
		if (!recovery || recovery.generation !== generation) return;
		if (!validHistoryMetadata(result)) {
			this.abortRecovery(room, 'Invalid history response');
			return;
		}
		this.observeHistoryResponse(room, result);
		if (room.recovery !== recovery || recovery.generation !== generation) return;
		this.applyPage(room, result);
		const lastId = isLogId(result.last_id) ? result.last_id : undefined;
		if (result.more) {
			if (!lastId || (recovery.nextAfter !== undefined && compareLogIds(lastId, recovery.nextAfter) < 0) || compareLogIds(lastId, recovery.head) >= 0) {
				this.abortRecovery(room, 'History pagination did not provide a valid continuation');
				return;
			}
			recovery.nextAfter = increment(lastId);
			recovery.requestId = undefined;
			this.requestHistoryPage(room, generation);
			this.emit();
			return;
		}
		this.finishRecovery(room);
		this.emit();
	}

	/** Install a page's records, skipping message and reaction records below the room's bound. */
	private applyPage(room: RoomState, result: JsonObject): void {
		const records: DecodedRecords = decodeHistoryRecords(result);
		const retained = (logId: string) => room.floor === undefined || compareLogIds(logId, room.floor) >= 0;
		for (const record of records.rooms) this.installRoom(record);
		for (const record of records.messages) if (retained(record.log_id)) this.installMessage(record);
		for (const record of records.reactions) if (retained(record.log_id)) this.store.putReaction(record);
		// Embedded reference snapshots install regardless of any room's bound.
		for (const record of records.embedded) this.installMessage(record);
	}

	private applyLive(live: LiveRecord): void {
		if (live.kind === 'message') this.installMessage(live.record);
		else this.store.putReaction(live.record);
	}

	private finishRecovery(room: RoomState): void {
		const recovery = room.recovery;
		if (!recovery) return;
		// A response may report a newer head than this recovery's fixed H. That
		// metadata must not turn H+1 and later live records into a checkpoint.
		room.checkpoint = maxDefined(room.checkpoint, recovery.head);
		room.recovery = undefined;
		room.dirty = true;
		for (const waiter of room.waiters.splice(0)) waiter.resolve();
	}

	private observeHead(room: RoomState, advertised: unknown): void {
		if (!isLogId(advertised)) return;
		if (room.latestLogId === undefined || compareLogIds(advertised, room.latestLogId) > 0) room.latestLogId = advertised;
	}

	private observeHistoryResponse(room: RoomState, result: ValidHistoryResponse): void {
		this.observeHead(room, result.latest_log_id);
		this.observeBoundary(room, result.history_log_id, result.latest_log_id);
	}

	/**
	 * Apply an advertised lower bound (`history_log_id`, or the same frame's or
	 * page's `latest_log_id + 1` when null) monotonically, evicting what fell
	 * below it and rebuilding a recovery the bound overtook.
	 */
	private observeBoundary(room: RoomState, advertised: string | null | undefined, responseHead: string | undefined): void {
		if (advertised === undefined) return;
		const effective = advertised === null ? (responseHead === undefined ? undefined : increment(responseHead)) : advertised;
		if (effective === undefined) return;
		if (room.floor !== undefined && compareLogIds(effective, room.floor) <= 0) {
			if (compareLogIds(effective, room.floor) === 0 && (room.historyLogId === undefined || (room.historyLogId === null && advertised !== null))) {
				room.historyLogId = advertised;
			}
			return;
		}
		room.floor = effective;
		room.historyLogId = advertised;
		this.store.evictBefore(room.id, effective);
		const recovery = room.recovery;
		if (!recovery) {
			if (this.recoversAutomatically(room) && room.latestLogId !== undefined &&
				(room.checkpoint === undefined || compareLogIds(increment(room.checkpoint), effective) < 0)) {
				this.startRecovery(room, room.latestLogId, true);
			}
			return;
		}
		recovery.buffer = recovery.buffer.filter((live) => isEmbedded(live) || compareLogIds(live.record.log_id, effective) >= 0);
		recovery.bufferBytes = recovery.buffer.reduce((bytes, live) => bytes + recordBytes(live.record), 0);
		// `nextAfter` is the first unprocessed position. Equality is safe; a
		// strictly larger bound means a retained gap was discarded underneath us.
		if (recovery.nextAfter === undefined || compareLogIds(effective, recovery.nextAfter) > 0) {
			// Keep this recovery's fixed H. Buffered live records at or above the
			// bound survive the rebuild.
			this.startRecovery(room, recovery.head, true, true);
		}
	}

	private restartRecoveryAfterOverflow(room: RoomState): void {
		const head = room.latestLogId ?? room.recovery!.head;
		this.startRecovery(room, head, true);
		this.error = 'History is arriving faster than the client can recover; reconnecting.';
		this.scheduleReconnect();
		if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.close(1008, 'history recovery overflow');
	}

	private abortRecovery(room: RoomState, message: string): void {
		if (!room.recovery) return;
		this.retireRecoveryRequest(room);
		room.recoveryError = message;
		// Live delivery remains authoritative even when history is incomplete:
		// publish it without advancing the checkpoint past an unrecovered gap.
		room.recovery = undefined;
		room.dirty = true;
		for (const waiter of room.waiters.splice(0)) waiter.reject(new Error(message));
		this.emit();
	}

	private retireRecoveryRequest(room: RoomState): void {
		const id = room.recovery?.requestId;
		if (!id) return;
		room.recovery!.requestId = undefined;
		const request = this.requests.get(id);
		if (!request) return;
		clearTimeout(request.timer);
		this.requests.delete(id);
		request.reject(new Error('History recovery superseded'));
	}

	private discardRoom(room: RoomState, reason: string): void {
		this.retireRecoveryRequest(room);
		room.recovery = undefined;
		room.loadGeneration += 1;
		for (const waiter of room.waiters.splice(0)) waiter.reject(new Error(reason));
	}

	/** Forget every connection-scoped protocol record; the next connection re-announces. */
	private discardProtocolView(reason: string): void {
		for (const room of this.rooms.values()) this.discardRoom(room, reason);
		this.rooms.clear();
		this.store.clear();
		this.store.takeTouched();
		this.reactionIntents.clear();
		this.pendingMessageSaves.clear();
		this.pendingRoomSaves.clear();
		this.activeRoomId = undefined;
		this.server = undefined;
		this.you = undefined;
	}

	private defaultRoomId(): string | undefined {
		for (const room of this.rooms.values()) if (!this.isThread(room.id)) return room.id;
		return this.rooms.keys().next().value;
	}

	/**
	 * An `activity` broadcast (Appendix D.1): present fields change the user's
	 * transient state, absent ones leave it. `typing` seconds show or refresh
	 * the indicator, `0` removes it. `read_message_id` is not used by this client.
	 */
	private handleActivity(params: JsonObject | undefined): void {
		if (!params || typeof params.room_id !== 'string' || !isIdentity(params.from)) return;
		const seconds = params.typing;
		if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return;
		const room = params.room_id;
		const from = cloneJson(params.from);
		this.removeTyping(room, from.user_id);
		if (seconds > 0) {
			const key = typingKey(room, from.user_id);
			this.typing.set(key, {
				room,
				from,
				timer: setTimeout(() => {
					this.typing.delete(key);
					this.emit();
				}, Math.min(seconds, MAX_TYPING_S) * 1000)
			});
		}
		this.emit();
	}

	private removeTyping(room: string, userId: string): void {
		const key = typingKey(room, userId);
		const current = this.typing.get(key);
		if (!current) return;
		clearTimeout(current.timer);
		this.typing.delete(key);
	}

	private handleResponse(id: string, result: JsonObject, rpcError?: RpcError): void {
		const request = this.requests.get(id);
		if (!request) return;
		this.requests.delete(id);
		clearTimeout(request.timer);
		if (rpcError) request.reject(this.errorFromRpc(isJsonObject(rpcError) ? rpcError : { code: -32603, message: 'Invalid error' }));
		else request.resolve(result);
		this.emit();
	}

	private errorFromRpc(rpcError: RpcError): Error {
		const retryAfter = retryAfterMilliseconds(rpcError);
		if (retryAfter !== undefined) {
			this.retryAfterUntil = Math.max(this.retryAfterUntil, Date.now() + retryAfter);
		}
		const error = new Error(userFacingRpcError(rpcError));
		(error as Error & { code?: number; retryAfterMs?: number }).code = rpcError.code;
		if (retryAfter !== undefined) (error as Error & { code?: number; retryAfterMs?: number }).retryAfterMs = retryAfter;
		return error;
	}

	private enqueueRequest<T extends JsonObject = JsonObject>(
		method: string,
		params: JsonObject,
		options: { visible: boolean; allowBeforeAuth: boolean }
	): OperationHandle<T> {
		const id = makeRequestId(method);
		if (this.passkeyAbort && method !== 'auth') {
			return rejectedHandle<T>(method, new Error('Finish signing in before sending requests'), id);
		}
		let resolvePromise!: (result: T) => void;
		let rejectPromise!: (error: Error) => void;
		const promise = new Promise<T>((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});
		const timer = setTimeout(() => {
			const request = this.requests.get(id);
			if (!request) return;
			this.requests.delete(id);
			request.reject(new Error(`${method} request timed out`));
			this.emit();
		}, REQUEST_TIMEOUT_MS);
		const request: PendingRequest = {
			id,
			method,
			params,
			visible: options.visible,
			allowBeforeAuth: options.allowBeforeAuth,
			createdAt: Date.now(),
			timer,
			resolve: resolvePromise as (result: JsonObject) => void,
			reject: rejectPromise
		};
		this.requests.set(id, request);
		this.sendRequest(request);
		this.emit();
		return { id, promise };
	}

	private canSend(request: PendingRequest): boolean {
		return Boolean(
			this.socket &&
			this.socket.readyState === WebSocket.OPEN &&
			(request.allowBeforeAuth || this.authenticated)
		);
	}

	private sendRequest(request: PendingRequest): void {
		if (!this.canSend(request) || request.sentConnection === this.connectionId) return;
		request.sentConnection = this.connectionId;
		this.sendFrame({ jsonrpc: '2.0', method: request.method, id: request.id, params: request.params });
	}

	private sendFrame(frame: WireFrame): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
		this.socket.send(JSON.stringify(frame));
	}

	private clearTransientRequests(): void {
		for (const [id, request] of this.requests) {
			clearTimeout(request.timer);
			this.requests.delete(id);
			request.reject(new Error('Connection closed; delivery is uncertain. Please retry'));
		}
	}

	private resetSession(reason: string): void {
		this.cancelPasskey();
		for (const request of this.requests.values()) {
			clearTimeout(request.timer);
			request.reject(new Error(reason));
		}
		this.requests.clear();
		this.discardProtocolView(reason);
		this.authenticated = false;
		this.authRequested = false;
		this.registeredSession = false;
		this.passkeyRequired = false;
		this.error = undefined;
		this.disconnectedAt = undefined;
		this.clearTyping();
		this.emit();
	}

	private clearTyping(): void {
		this.sentTypingAt.clear();
		for (const typing of this.typing.values()) clearTimeout(typing.timer);
		this.typing.clear();
	}

	private handleConnectionFailure(id: number, message: string): void {
		if (id !== this.connectionId) return;
		this.error = message;
		if (this.running) this.disconnectedAt ??= Date.now();
		this.status = this.running ? 'reconnecting' : 'offline';
		if (this.running) this.scheduleReconnect();
		this.emit();
	}

	private scheduleReconnect(delayOverride?: number): void {
		if (!this.running || this.reconnectTimer || this.reconnectHeld) return;
		this.reconnectAttempt += 1;
		const retryAfter = this.retryAfterRemaining();
		const delay = delayOverride !== undefined
			? Math.max(delayOverride, retryAfter ?? 0)
			: reconnectDelay(this.reconnectAttempt, Math.random(), retryAfter);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connectNow();
		}, delay);
	}

	/**
	 * Session tokens are kept per server URL in localStorage so a reload, a new
	 * tab, or a browser restart resumes the passkey identity without another
	 * ceremony, until the server expires the session. Sign-out or a rejected
	 * resume removes the entry.
	 */
	private sessionStorageKey(): string {
		return `apron.session:${this.serverUrl}`;
	}

	private loadStoredSession(): void {
		let stored: string | null = null;
		try {
			stored = globalThis.localStorage?.getItem(this.sessionStorageKey()) ?? null;
		} catch {
			// Storage can be unavailable (private mode, blocked site data).
		}
		if (!stored) return;
		this.sessionToken = stored;
		this.passkeyRequired = true;
		this.registeredSession = true;
	}

	private storeSession(token: string | undefined): void {
		try {
			const storage = globalThis.localStorage;
			if (!storage) return;
			if (token) storage.setItem(this.sessionStorageKey(), token);
			else storage.removeItem(this.sessionStorageKey());
		} catch {
			// Best effort; the in-memory token still covers this page's lifetime.
		}
	}

	private retryAfterRemaining(): number | undefined {
		const remaining = this.retryAfterUntil - Date.now();
		return remaining > 0 ? Math.min(RETRY_AFTER_MAX_MS, remaining) : undefined;
	}

	private isCurrentSocket(id: number, socket: WebSocket): boolean {
		return id === this.connectionId && this.socket === socket;
	}

	private emit(): void {
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}
}

/** Messages of a room in timeline order. */
export function timelineMessages(room: RoomSnapshot | undefined): MessageRecord[] {
	return room ? timelineEvents(room.timeline) : [];
}

/** Aggregated reactions of a message in a room's timeline, if any. */
export function messageReactions(room: RoomSnapshot | undefined, messageId: string): ReactionSummary[] | undefined {
	return room?.timeline.reactions[messageId];
}

/** Finds a message in any visible room's published timeline (for example a cross-room reply target). */
export function findMessage(rooms: readonly RoomSnapshot[], messageId: string): MessageRecord | undefined {
	for (const room of rooms) {
		const message = room.timeline.events[messageId];
		if (message) return message;
	}
	return undefined;
}

/** Rooms without a parent, in announcement order. */
export function topLevelRooms(rooms: readonly RoomSnapshot[]): RoomSnapshot[] {
	return rooms.filter((room) => room.parentRoomId === undefined);
}

/** Direct children (threads) of a room, in announcement order. */
export function childRooms(rooms: readonly RoomSnapshot[], parentRoomId: string): RoomSnapshot[] {
	return rooms.filter((room) => room.parentRoomId === parentRoomId);
}

/** Whether a `server` frame advertises a capability (§4). Capabilities gate UI, not authorization. */
export function hasCapability(server: ServerParams | undefined, cap: Capability): boolean {
	return server?.caps?.includes(cap) === true;
}

export function capabilitiesOf(server: ServerParams | undefined): Capabilities {
	return Object.fromEntries(CAPABILITIES.map((cap) => [cap, hasCapability(server, cap)])) as Capabilities;
}

/** Edit, move, and delete controls (cap `edit`). */
export const canEdit = (server: ServerParams | undefined) => hasCapability(server, 'edit');
/** Room and thread creation and room updates (cap `rooms`). */
export const canManageRooms = (server: ServerParams | undefined) => hasCapability(server, 'rooms');
/** Reaction controls (cap `reactions`). */
export const canReact = (server: ServerParams | undefined) => hasCapability(server, 'reactions');
/** History recovery and paging (cap `history`). */
export const hasHistory = (server: ServerParams | undefined) => hasCapability(server, 'history');

export function defaultWebSocketUrl(locationLike?: Location): string {
	const configured = import.meta.env.VITE_DEFAULT_SERVER_URL;
	if (configured) return configured;
	if (!locationLike) return 'ws://localhost:8080/ws';
	const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${protocol}//${locationLike.host}/ws`;
}

export function normalizeWebSocketUrl(input: string, locationLike?: Location): string {
	const value = input.trim();
	if (!value) return defaultWebSocketUrl(locationLike);
	if (value.startsWith('ws://') || value.startsWith('wss://')) return new URL(value).toString();
	if (value.startsWith('http://') || value.startsWith('https://')) {
		return new URL(value.replace(/^http/, 'ws')).toString();
	}
	if (value.startsWith('/')) {
		const base = locationLike ? `${locationLike.protocol === 'https:' ? 'wss:' : 'ws:'}//${locationLike.host}` : 'ws://localhost:5173';
		return `${base}${value}`;
	}
	return new URL(`ws://${value}`).toString();
}

function makeRequestId(method: string): string {
	const random = globalThis.crypto?.randomUUID?.();
	return `${method}_${random ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function rejectedHandle<T extends JsonObject>(method: string, error: Error, id = makeRequestId(method)): OperationHandle<T> {
	const promise = Promise.reject(error);
	// Callers that only look at the handle id must not trigger an unhandled rejection.
	promise.catch(() => undefined);
	return { id, promise };
}

function typingKey(room: string, userId: string): string {
	return JSON.stringify([room, userId]);
}

function increment(id: string): string {
	return (BigInt(id) + 1n).toString();
}

function maxDefined(a: string | undefined, b: string | undefined): string | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return compareLogIds(a, b) >= 0 ? a : b;
}

/** A message's client fields (Appendix B), as a save would submit them. */
function messageClientFields(record: MessageRecord): JsonObject {
	const fields: JsonObject = { room_id: record.room_id };
	if (record.body !== undefined) fields.body = record.body;
	if (record.reply_to) fields.reply_to = { message_id: record.reply_to.message_id };
	if (record.deleted === true) fields.deleted = true;
	if (record.ext !== undefined) fields.ext = record.ext;
	return fields;
}

/** A room's client fields other than `parent_room_id`, as an update would submit them. */
function roomClientFields(record: RoomRecord): JsonObject {
	const fields: JsonObject = {};
	if (record.title !== undefined) fields.title = record.title;
	if (record.intro_message) fields.intro_message = { message_id: record.intro_message.message_id };
	if (record.ext !== undefined) fields.ext = record.ext;
	return fields;
}

/** JSON with object keys sorted, for order-insensitive comparison (prototype-like keys included). */
function canonicalJson(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
	if (isJsonObject(value)) {
		return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value ?? null);
}

function sameEmojiSet(left: readonly string[], right: readonly string[]): boolean {
	const a = new Set(left), b = new Set(right);
	return a.size === b.size && [...a].every((emoji) => b.has(emoji));
}

function isEmbedded(live: LiveRecord): boolean {
	return live.kind === 'message' && live.embedded === true;
}

function historyParams(roomId: string, after: string | undefined, before: string): JsonObject {
	return { room_id: roomId, after: after ?? FIRST_LOG_ID, before, limit: HISTORY_PAGE_SIZE };
}

function validHistoryMetadata(result: JsonObject): result is ValidHistoryResponse {
	if (!Array.isArray(result.entries) || typeof result.more !== 'boolean' || !isLogId(result.latest_log_id)) return false;
	if (result.history_log_id !== null && !isLogId(result.history_log_id)) return false;
	return result.history_log_id === null || compareLogIds(result.history_log_id, result.latest_log_id) <= 0;
}

function recordBytes(record: unknown): number {
	try {
		return new TextEncoder().encode(JSON.stringify(record)).byteLength;
	} catch {
		return MAX_HISTORY_BUFFER_BYTES + 1;
	}
}

/** Pure admission check used to keep live/recovery memory bounded. */
export function recoveryBufferFits(
	entryCount: number,
	bufferBytes: number,
	record: unknown,
	maxEntries = MAX_HISTORY_BUFFER_ENTRIES,
	maxBytes = MAX_HISTORY_BUFFER_BYTES
): boolean {
	return entryCount < maxEntries && bufferBytes + recordBytes(record) <= maxBytes;
}

/** `retry_after` errors carry `data.retry_after`, a delay in seconds (§1.1). */
function retryAfterMilliseconds(error: RpcError): number | undefined {
	if (error.code !== -32002 || !isJsonObject(error.data) || typeof error.data.retry_after !== 'number') return undefined;
	if (!Number.isFinite(error.data.retry_after) || error.data.retry_after < 0) return undefined;
	return Math.min(RETRY_AFTER_MAX_MS, Math.ceil(error.data.retry_after * 1000));
}

function userFacingRpcError(error: RpcError): string {
	const retryAfter = retryAfterMilliseconds(error);
	if (retryAfter !== undefined) {
		const seconds = Math.max(1, Math.ceil(retryAfter / 1000));
		if (error.message) return `${error.message} Try again in ${seconds}s.`;
		return `Temporarily limited. Try again in ${seconds}s.`;
	}
	return error.message || `Request failed (${error.code})`;
}

/** Exposed for deterministic UI/client tests without relying on timer scheduling. */
export function reconnectDelay(attempt: number, random = 0.5, retryAfterMs?: number): number {
	const boundedAttempt = Math.max(1, Math.floor(attempt));
	const base = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(7, boundedAttempt - 1));
	const jitter = 0.8 + Math.min(1, Math.max(0, random)) * 0.4;
	return Math.max(retryAfterMs ?? 0, Math.round(base * jitter));
}

// Re-exported for callers that build saves or projections themselves.
export { cloneJson };
