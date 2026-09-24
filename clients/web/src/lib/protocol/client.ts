import { conditionalPasskeysAvailable, immediatePasskeysAvailable, requestPasskey, type PasskeyMediation } from './webauthn';
import { writeEmbed } from './embeds';
import {
	ProtocolStore,
	compareLogIds,
	createTimeline,
	decodeHistoryRecords,
	timelineEvents,
	type DecodedRecords,
	type ReactionSummary,
	type RoomRename,
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

export type { ReactionSummary, RoomRename, TimelineState } from './reducer';

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
	/** Title changes seen in the room's log, ascending (absent when none). */
	renames?: RoomRename[];
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
	/** Your read cursor in this room (Appendix D.1), as the server last reported or you advanced it. */
	readMessageId?: string;
	/** The room's members from the latest `room_list` that listed it (Appendix C). */
	members?: Identity[];
	/** The room's `latest_log_id` in that listing: whoever posted after it was around since. */
	membersAsOf?: string;
}

/**
 * A visible room as `room_list` returns it (Appendix C): its record, its head,
 * and its members. Listing a room does not join it.
 */
export interface RoomListing {
	id: string;
	title: string;
	record: RoomRecord;
	parentRoomId?: string;
	latestLogId?: string;
	members: Identity[];
	/** Announced to this connection: the user has joined it. */
	joined: boolean;
}

/** A file this client is writing to an embed's `write_url` (Appendix E). */
export interface UploadState {
	name: string;
	/** Fraction written, 0–1, once the write started. */
	progress?: number;
	/** Why the write failed; the server then publishes the message without the embed. */
	failed?: string;
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
	/** This browser has signed in to this server with a passkey before. */
	passkeyHint?: boolean;
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
	/**
	 * The latest user object seen for each `user_id` (§3.3): from `you`, `user`
	 * notifications, and `members`, then live `from`s. Render every message
	 * with it. Look users up with `userIn`, which follows renames.
	 */
	users: Record<string, Identity>;
	/** Retired `user_id`s mapped to the identity that replaced them (a `user` notification with `old`). */
	userAliases: Record<string, string>;
	/** Files being written to upload embeds, by `embed_id`. */
	uploads: Record<string, UploadState>;
	/** Top-level rooms from the latest `room_list`, joined or not; undefined until listed. */
	directory?: RoomListing[];
	/** Threads per parent room from the latest `room_list` with `parent_room_id`. */
	threadDirectory: Record<string, RoomListing[]>;
	showReconnectDivider: boolean;
	/** Server supplied retry delay for the most recent temporary limit. */
	retryAfterMs?: number;
	/** The server denied the connection (§1.1): no reconnect until the user acts (`retryNow`). */
	held?: boolean;
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
/**
 * The demo worker's keepalive, sent verbatim so its runtime can answer it
 * without waking the server. Any other server ignores it as an unknown
 * notification (§1).
 */
const KEEPALIVE_FRAME = '{"method":"ping"}';
const MAX_HISTORY_BUFFER_ENTRIES = 1_000;
const MAX_HISTORY_BUFFER_BYTES = 1_048_576;
const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;
/** Passkey autofill re-issues its login challenge this long before the server's `timeout`. */
const AUTOFILL_REFRESH_MARGIN_MS = 10_000;
const AUTOFILL_MIN_REFRESH_MS = 15_000;
/** Assumed challenge lifetime when the server's options carry no `timeout`. */
const AUTOFILL_CHALLENGE_MS = 120_000;
/** How long a passkey ceremony waits for in-flight requests (history, a rename) before giving up. */
const PASSKEY_IDLE_WAIT_MS = 5_000;
const PASSKEY_IDLE_POLL_MS = 50;
/** The lowest possible log_id: the `after` bound when no lower bound is known. */
const FIRST_LOG_ID = '1';
const CAPABILITIES: Capability[] = ['history', 'edit', 'rooms', 'reactions', 'activity', 'embed:upload', 'embed:stream'];
/** The room of the avatar upload convention (Appendix J.4). */
export const AVATAR_ROOM = '@avatar';

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
	/** Latest user object per user_id, and whether it came from a profile (you, user, members) rather than a `from`. */
	private readonly users = new Map<string, { identity: Identity; profile: boolean }>();
	private readonly userAliases = new Map<string, string>();
	/** Read cursors per room, per user (Appendix D.1). */
	private readonly reads = new Map<string, Map<string, string>>();
	private readonly uploads = new Map<string, UploadState>();
	private readonly roomMembers = new Map<string, { members: Identity[]; asOf?: string }>();
	private directory?: RoomListing[];
	private readonly threadDirectory = new Map<string, RoomListing[]>();
	private socket?: WebSocket;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private keepaliveTimer?: ReturnType<typeof setInterval>;
	/** Keepalives sent on the current socket since its last answer. */
	private unansweredPings = 0;
	/** Drops the current socket as if it had closed: for one that stopped answering. */
	private abandonSocket?: () => void;
	private connectionId = 0;
	private reconnectAttempt = 0;
	private running = false;
	private authenticated = false;
	private authRequested = false;
	private passkeyAbort?: AbortController;
	/** A pending autofill (conditional) login; `done` settles once it lets go of the browser. */
	private autofill?: { controller: AbortController; done: Promise<void> };
	private passkeyHint = false;
	// Keep bearer credentials in memory, scoped to this server and mounted client.
	private sessionToken?: string;
	private passkeyRequired = false;
	private registeredSession = false;
	private activeRoomId?: string;
	private server?: ServerParams;
	private you?: Identity;
	private displayName = '';
	/** The `me` request `handleAuth` sent for `displayName`, if any. */
	private authNameRequest?: OperationHandle;
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
		this.passkeyHint = this.loadPasskeyHint();
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
		this.stopKeepalive();
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
			passkeyHint: this.passkeyHint,
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
				const renames = this.store.roomRenames(room.id);
				return {
					id: room.id,
					title: typeof record?.title === 'string' && record.title ? record.title : room.id,
					...(record ? { record } : {}),
					...(thread ? { parentRoomId: record!.parent_room_id } : {}),
					...(record?.intro_message ? { introMessageId: record.intro_message.message_id } : {}),
					...(intro ? { introMessage: intro } : {}),
					...(record && isJsonObject(record.ext) ? { ext: record.ext } : {}),
					...(renames.length ? { renames } : {}),
					...(room.latestLogId !== undefined ? { latestLogId: room.latestLogId } : {}),
					...(room.historyLogId !== undefined ? { historyLogId: room.historyLogId } : {}),
					timeline: room.timeline,
					recovering: Boolean(room.recovery),
					...(room.recoveryError ? { recoveryError: room.recoveryError } : {}),
					loaded: !history || (thread ? room.loadCheckpoint !== undefined : room.checkpoint !== undefined),
					loading: room.loading,
					...(this.readCursor(room.id) !== undefined ? { readMessageId: this.readCursor(room.id) } : {}),
					...this.membersOf(room.id)
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
			users: Object.fromEntries([...this.users].map(([id, entry]) => [id, entry.identity])),
			userAliases: Object.fromEntries(this.userAliases),
			uploads: Object.fromEntries(this.uploads),
			...(this.directory ? { directory: this.directory.map((listing) => this.withJoined(listing)) } : {}),
			threadDirectory: Object.fromEntries([...this.threadDirectory].map(([parent, listings]) => [parent, listings.map((listing) => this.withJoined(listing))])),
			showReconnectDivider: this.showReconnectDivider,
			retryAfterMs: this.retryAfterRemaining(),
			...(this.reconnectHeld ? { held: true } : {}),
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

	/**
	 * Runs a passkey ceremony. A `name` becomes the display name once the
	 * ceremony succeeds, so a handle a guest could not set is applied as soon as
	 * the session is registered. Resolves with the `me` request sent for the
	 * display name after authenticating, if any, so callers can show what the
	 * server kept.
	 */
	async usePasskey(
		action: 'register' | 'login', name?: string, mediation: PasskeyMediation = 'modal'
	): Promise<OperationHandle | undefined> {
		if (!this.server?.auth.includes('webauthn')) throw new Error('This server does not support passkeys');
		// A pending autofill holds the browser's credential request; release it first.
		await this.stopAutofill();
		// Requests sent as the old identity settle first; right after connecting
		// that is usually history and the `me` for the display name.
		for (let waited = 0; (this.authRequested || this.requests.size) && waited < PASSKEY_IDLE_WAIT_MS; waited += PASSKEY_IDLE_POLL_MS) {
			await new Promise((resolve) => setTimeout(resolve, PASSKEY_IDLE_POLL_MS));
		}
		if (this.passkeyAbort || this.authRequested || this.requests.size) throw new Error('Wait for pending requests to finish, then try again');
		if (this.status !== 'connected') throw new Error('Connect to the server first');
		const controller = new AbortController();
		this.passkeyAbort = controller;
		const connection = this.connectionId;
		this.emit();
		try {
			const begun = await this.passkeyBegin(action);
			const credential = await requestPasskey(action, begun.options, controller.signal, mediation);
			if (controller.signal.aborted || connection !== this.connectionId) throw new Error('Connection changed; try again');
			return await this.passkeyFinish(action, begun.challengeId, credential, controller, connection, name);
		} finally {
			if (this.passkeyAbort === controller) this.cancelPasskey();
			this.emit();
		}
	}

	/**
	 * What `continueWithPasskey` tries first: an `immediate` login where the
	 * browser supports it, otherwise a login when this browser has used a
	 * passkey here before, and a registration when it has not.
	 */
	async passkeyPlan(): Promise<'immediate' | 'login' | 'register'> {
		if (await immediatePasskeysAvailable()) return 'immediate';
		return this.passkeyHint ? 'login' : 'register';
	}

	/**
	 * One "sign in or create" action. Browsers deliberately don't reveal whether
	 * a passkey exists without asking, so this signs in when `immediate`
	 * mediation finds one on this device and registers a new passkey when it
	 * doesn't; elsewhere it follows `passkeyPlan`. `name` is applied as with
	 * `usePasskey`.
	 */
	async continueWithPasskey(name?: string): Promise<{ action: 'register' | 'login'; named?: OperationHandle }> {
		const plan = await this.passkeyPlan();
		const fallback = this.passkeyHint ? 'login' : 'register';
		if (plan !== 'immediate') return { action: plan, named: await this.usePasskey(plan, name) };
		try {
			return { action: 'login', named: await this.usePasskey('login', name, 'immediate') };
		} catch (cause) {
			// The browser refused `immediate` as an option after all: sign in or
			// register as if it were unsupported.
			if (cause instanceof TypeError) return { action: fallback, named: await this.usePasskey(fallback, name) };
			// No passkey for this server on this device, or the picker was dismissed.
			if (!(cause instanceof DOMException && cause.name === 'NotAllowedError')) throw cause;
		}
		return { action: 'register', named: await this.usePasskey('register', name) };
	}

	/**
	 * Offers this server's passkeys in the autofill of a field marked
	 * `autocomplete="username webauthn"` until `signal` aborts, re-issuing the
	 * challenge before it expires. Resolves with the `me` request (as
	 * `usePasskey` does) once the user signs in by picking a passkey, or with
	 * `undefined` if autofill stops first: aborted, unsupported, the connection
	 * changed, or an explicit ceremony took over. Only failures after a passkey
	 * was picked reject. `name` is read when a passkey is picked.
	 */
	async passkeyAutofill(
		signal: AbortSignal, name?: () => string | undefined
	): Promise<{ named?: OperationHandle } | undefined> {
		const idle = () => !signal.aborted && !this.autofill && !this.passkeyAbort && this.authenticated &&
			this.status === 'connected' && !!this.server?.auth.includes('webauthn');
		if (!idle() || !(await conditionalPasskeysAvailable()) || !idle()) return undefined;
		const controller = new AbortController();
		const stop = () => controller.abort(signal.reason);
		signal.addEventListener('abort', stop, { once: true });
		let release!: () => void;
		const run = { controller, done: new Promise<void>((resolve) => (release = resolve)) };
		this.autofill = run;
		try {
			const picked = await this.awaitAutofillPick(controller.signal);
			if (this.autofill === run) this.autofill = undefined;
			release();
			if (!picked || this.passkeyAbort || picked.connection !== this.connectionId) return undefined;
			// From here it is an ordinary login ceremony.
			const ceremony = new AbortController();
			this.passkeyAbort = ceremony;
			this.emit();
			try {
				return { named: await this.passkeyFinish('login', picked.challengeId, picked.credential, ceremony, picked.connection, name?.()) };
			} finally {
				if (this.passkeyAbort === ceremony) this.cancelPasskey();
				this.emit();
			}
		} finally {
			signal.removeEventListener('abort', stop);
			if (this.autofill === run) this.autofill = undefined;
			release();
		}
	}

	private async awaitAutofillPick(
		signal: AbortSignal
	): Promise<{ challengeId: string; credential: JsonObject; connection: number } | undefined> {
		while (!signal.aborted) {
			const connection = this.connectionId;
			let begun: Awaited<ReturnType<ChatClient['passkeyBegin']>>;
			try {
				begun = await this.passkeyBegin('login');
			} catch {
				return undefined;
			}
			if (signal.aborted || connection !== this.connectionId) return undefined;
			const timeout = typeof begun.publicKey.timeout === 'number' ? begun.publicKey.timeout : AUTOFILL_CHALLENGE_MS;
			const round = new AbortController();
			const forward = () => round.abort(signal.reason);
			signal.addEventListener('abort', forward, { once: true });
			// Browsers may keep a conditional request open past `timeout`; the
			// server's challenge would not survive that, so re-issue it first.
			const timer = setTimeout(
				() => round.abort(new DOMException('Passkey challenge expired', 'TimeoutError')),
				Math.max(AUTOFILL_MIN_REFRESH_MS, timeout - AUTOFILL_REFRESH_MARGIN_MS)
			);
			try {
				const credential = await requestPasskey('login', begun.options, round.signal, 'conditional');
				if (signal.aborted || connection !== this.connectionId) return undefined;
				return { challengeId: begun.challengeId, credential, connection };
			} catch {
				// Stopped, or the browser refused: give up. Only an expired challenge retries.
				if (signal.aborted || !round.signal.aborted) return undefined;
			} finally {
				clearTimeout(timer);
				signal.removeEventListener('abort', forward);
			}
		}
		return undefined;
	}

	/** Stops a pending autofill and waits until the browser has let go of its request. */
	private async stopAutofill(): Promise<void> {
		const run = this.autofill;
		if (!run) return;
		run.controller.abort(new DOMException('Passkey autofill stopped', 'AbortError'));
		await run.done;
	}

	private async passkeyBegin(action: 'register' | 'login'): Promise<{ challengeId: string; options: JsonObject; publicKey: JsonObject }> {
		const options = await this.passkeyRequest({ scheme: 'webauthn', action, step: 'begin' });
		const challengeId = typeof options.challenge_id === 'string' && options.challenge_id.length > 0
			? options.challenge_id : undefined;
		if (!challengeId) throw new Error('Passkey challenge was missing; try again');
		if (!isJsonObject(options.public_key)) throw new Error('Passkey options were missing; try again');
		return { challengeId, options, publicKey: options.public_key };
	}

	private async passkeyFinish(
		action: 'register' | 'login', challengeId: string, credential: JsonObject,
		controller: AbortController, connection: number, name: string | undefined
	): Promise<OperationHandle | undefined> {
		const finish = { scheme: 'webauthn', action, step: 'finish', challenge_id: challengeId, credential };
		const result = await this.passkeyRequest(finish);
		if (controller.signal.aborted || connection !== this.connectionId) throw new Error('Connection changed; try again');
		this.cancelPasskey();
		if (name?.trim()) this.displayName = name.trim();
		if (!this.handleAuth(result, true)) throw new Error('Server authentication response did not include an identity');
		return this.authNameRequest;
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

	/** Abandons a passkey prompt the user walked away from; its ceremony rejects with an AbortError. */
	cancelPasskeyPrompt(): void {
		if (!this.passkeyAbort) return;
		this.passkeyAbort.abort(new DOMException('Cancelled', 'AbortError'));
		this.passkeyAbort = undefined;
		this.emit();
	}

	private cancelPasskey(): void {
		this.passkeyAbort?.abort(new DOMException('Connection changed; try again', 'AbortError'));
		this.passkeyAbort = undefined;
		this.autofill?.controller.abort(new DOMException('Connection changed', 'AbortError'));
	}

	/**
	 * Posts a message (§3.5). `format` defaults to `plain`; `replyTo` names a
	 * message in any room and is sent as a bare reference.
	 */
	send(room: string, text: string, format: MessageFormat = 'plain', options: SendOptions = {}): OperationHandle<MessageResult> {
		// The message ends this user's typing indicator for everyone (Appendix D.1),
		// so no `typing: 0` needs to follow it.
		this.sentTypingAt.delete(room);
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
	 * Advances your read cursor in a room (cap `activity`, Appendix D.1) to a
	 * message, if that is further than the cursor already is. The server
	 * syncs it to your other connections.
	 */
	markRead(roomId: string, messageId: string): void {
		if (!this.authenticated || !this.hasCap('activity') || !isLogId(messageId)) return;
		const current = this.readCursor(roomId);
		if (current !== undefined && compareLogIds(messageId, current) <= 0) return;
		this.setReadCursor(roomId, this.you!.user_id, messageId);
		this.sendFrame({ method: 'activity', params: { room_id: roomId, read_message_id: messageId } });
		this.emit();
	}

	/** A room's snapshot fields from its latest listing, if it has been listed. */
	private membersOf(roomId: string): Pick<RoomSnapshot, 'members' | 'membersAsOf'> {
		const listed = this.roomMembers.get(roomId);
		if (!listed) return {};
		return { members: listed.members, ...(listed.asOf !== undefined ? { membersAsOf: listed.asOf } : {}) };
	}

	/**
	 * Lists visible rooms (cap `rooms`, Appendix C): top-level rooms, or with
	 * `parentRoomId` that room's threads, including ones never announced. The
	 * result also lands in the snapshot's `directory` or `threadDirectory`, and
	 * members become known users.
	 */
	listRooms(parentRoomId?: string): Promise<RoomListing[]> {
		const params: JsonObject = parentRoomId === undefined ? {} : { parent_room_id: parentRoomId };
		return this.enqueueRequest('room_list', params, { visible: false, allowBeforeAuth: false }).promise.then((result) => {
			const listings: RoomListing[] = [];
			for (const value of Array.isArray(result.rooms) ? result.rooms : []) {
				const decoded = decodeRoom(value);
				if (!decoded) continue;
				const members = (isJsonObject(value) && Array.isArray(value.members) ? value.members : []).filter(isIdentity).map((member) => cloneJson(member));
				for (const member of members) this.noteUser(member, 'profile');
				for (const message of decoded.embedded) this.installMessage(message);
				const record = decoded.record;
				this.roomMembers.set(record.room_id, { members, ...(decoded.delivery.latest_log_id !== undefined ? { asOf: decoded.delivery.latest_log_id } : {}) });
				listings.push({
					id: record.room_id,
					title: typeof record.title === 'string' && record.title ? record.title : record.room_id,
					record,
					...(record.parent_room_id !== undefined ? { parentRoomId: record.parent_room_id } : {}),
					...(decoded.delivery.latest_log_id !== undefined ? { latestLogId: decoded.delivery.latest_log_id } : {}),
					members,
					joined: false
				});
			}
			if (parentRoomId === undefined) this.directory = listings;
			else this.threadDirectory.set(parentRoomId, listings);
			this.emit();
			return listings.map((listing) => this.withJoined(listing));
		});
	}

	private withJoined(listing: RoomListing): RoomListing {
		return { ...listing, joined: this.rooms.has(listing.id) };
	}

	/**
	 * Updates your profile with `me` (§3.3): given fields replace the current
	 * ones and `""` (or `{}` for `ext`) removes one. Resolves with the `you`
	 * the server kept, which may differ from what was asked.
	 */
	updateProfile(patch: { name?: string; avatar?: string; ext?: JsonObject }): Promise<Identity> {
		if (patch.name !== undefined) this.displayName = patch.name.trim();
		return this.enqueueRequest('me', { ...patch }, { visible: true, allowBeforeAuth: false }).promise.then((result) => {
			if (!isIdentity(result.you)) throw new Error('The server did not return your profile');
			this.setYou(cloneJson(result.you));
			this.emit();
			return this.you!;
		});
	}

	/**
	 * Posts a message with files attached as `upload` embeds (cap
	 * `embed:upload`, Appendix E): the message goes out with one pending embed
	 * per file, then each file is written to the `write_url` the result lists.
	 * `sent` settles with the message result; `uploaded` when every write has
	 * finished. Progress and failures appear in the snapshot's `uploads`.
	 */
	sendFiles(room: string, text: string, files: File[], format: MessageFormat = 'plain', options: SendOptions = {}): { sent: Promise<MessageResult>; uploaded: Promise<void> } {
		const uploads: Embed[] = files.map((file) => ({ kind: 'upload', ...(file.name ? { title: file.name } : {}) }));
		const handle = this.send(room, text, format, { ...options, embeds: [...(options.embeds ?? []), ...uploads] });
		const uploaded = handle.promise.then((result) => this.writeUploads(result, files));
		return { sent: handle.promise, uploaded };
	}

	/**
	 * Uploads an image as your avatar (Appendix J.4): a message to room
	 * `@avatar` with one upload embed. The server sets `avatar` and sends a
	 * `user` notification once the image is written.
	 */
	uploadAvatar(file: File): Promise<void> {
		const request = this.enqueueRequest<MessageResult>('message', {
			room_id: AVATAR_ROOM,
			body: { embeds: [{ kind: 'upload', ...(file.name ? { title: file.name } : {}) }] }
		}, { visible: true, allowBeforeAuth: false });
		return request.promise.then((result) => this.writeUploads(result, [file]));
	}

	/** Writes each file to the upload embed the result lists for it, in order. */
	private async writeUploads(result: JsonObject, files: File[]): Promise<void> {
		const written = (Array.isArray(result.embeds) ? result.embeds : [])
			.filter((embed): embed is JsonObject => isJsonObject(embed) && embed.kind === 'upload' && typeof embed.write_url === 'string' && typeof embed.embed_id === 'string');
		if (written.length < files.length) throw new Error('The server did not accept the attachment');
		const failures: string[] = [];
		await Promise.all(files.map(async (file, index) => {
			const embedId = written[index].embed_id as string;
			const state: UploadState = { name: file.name || 'File', progress: 0 };
			this.uploads.set(embedId, state);
			this.emit();
			try {
				await writeEmbed(written[index].write_url as string, file, (progress) => {
					state.progress = progress;
					this.emit();
				});
				this.uploads.delete(embedId);
			} catch (cause) {
				state.failed = cause instanceof Error ? cause.message : 'Upload failed';
				failures.push(state.failed);
			}
			this.emit();
		}));
		if (failures.length) throw new Error(failures[0]);
	}

	/** Forget a failed upload's state once the UI has shown it. */
	dismissUpload(embedId: string): void {
		if (this.uploads.delete(embedId)) this.emit();
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
		const closed = (): void => {
			if (!this.isCurrentSocket(id, socket)) return;
			this.abandonSocket = undefined;
			this.cancelPasskey();
			this.showReconnectDivider = this.rooms.size > 0 || this.showReconnectDivider;
			this.socket = undefined;
			this.authenticated = false;
			this.authRequested = false;
			this.clearTransientRequests();
			this.clearTyping();
			this.stopKeepalive();
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
		socket.onclose = closed;
		// A socket whose peer vanished can stay OPEN here indefinitely; close it
		// and carry on as if the close had arrived, without waiting for it.
		this.abandonSocket = () => {
			try { socket.close(4000, 'keepalive unanswered'); } catch { /* already closed */ }
			closed();
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
			case 'user':
				this.handleUser(frame.params);
				return;
			case 'pong':
				this.unansweredPings = 0;
				return;
		}
		if (frame.method !== undefined) return;
		if (typeof frame.id === 'string' && (frame.result !== undefined || frame.error !== undefined)) {
			this.handleResponse(frame.id, isJsonObject(frame.result) ? frame.result : {}, frame.error);
		} else if (frame.id === undefined) {
			// An error without `id` is not tied to a request (§1.1).
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
					// Wait for the user's "Sign in" instead of prompting again on every reconnect.
					this.reconnectHeld = true;
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
			this.error = cause.message;
			// Never silently downgrade a passkey session to a different guest identity.
			if (resume) {
				const code = (cause as Error & { code?: number }).code;
				if (code === -32001 || code === -32602) {
					// The session is over. Signing in again takes a passkey prompt, which
					// waits for the user's "Sign in" rather than popping up on its own.
					this.sessionToken = undefined;
					this.storeSession(undefined);
					this.reconnectHeld = true;
				}
				// A limit or timeout keeps the token: reconnect, after any retry_after, and resume again.
				socket?.close(1000, 'resume failed');
			}
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
			this.rememberPasskey();
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
		this.authNameRequest = this.displayName ? this.sendName() : undefined;
		this.startKeepalive();
		this.emit();
		return true;
	}

	/**
	 * Sends the keepalive the server asks for in `ext.demo.keepalive_seconds`,
	 * now and then at that interval, for as long as this socket is current.
	 * The demo worker cannot ping, so this is how it tells a connection that is
	 * still there from one whose peer vanished without closing it; it also
	 * keeps Cloudflare from dropping the socket as idle. When two keepalives
	 * in a row go unanswered, the socket is presumed dead and replaced. Counting
	 * keepalives rather than time means a tab whose timers were frozen probes
	 * again after it wakes instead of dropping a socket that may still work.
	 */
	private startKeepalive(): void {
		this.stopKeepalive();
		const seconds = this.server?.ext?.demo?.keepalive_seconds;
		const socket = this.socket;
		if (!socket || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return;
		const interval = Math.max(5, seconds) * 1_000;
		this.unansweredPings = 0;
		const ping = (): boolean => {
			if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return false;
			socket.send(KEEPALIVE_FRAME);
			this.unansweredPings += 1;
			return true;
		};
		if (!ping()) return;
		const timer = setInterval(() => {
			if (socket === this.socket && this.unansweredPings >= 2) {
				this.abandonSocket?.();
			} else if (ping()) {
				return;
			}
			clearInterval(timer);
			if (this.keepaliveTimer === timer) this.keepaliveTimer = undefined;
		}, interval);
		this.keepaliveTimer = timer;
	}

	private stopKeepalive(): void {
		if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
		this.keepaliveTimer = undefined;
	}

	private setYou(identity: Identity): void {
		const changed = this.you?.user_id !== identity.user_id;
		this.you = identity;
		this.noteUser(identity, 'profile');
		// `mine` in every reaction summary depends on the viewer.
		if (changed) for (const room of this.rooms.values()) room.dirty = true;
	}

	/**
	 * A `user` notification (§3.3): `you` replaces this connection's identity;
	 * `new` is another user's latest profile, and with `old` the old
	 * `user_id` now stands for the new identity.
	 */
	private handleUser(params: JsonObject | undefined): void {
		if (!params) return;
		if (isIdentity(params.you)) {
			this.setYou(cloneJson(params.you));
		} else if (isIdentity(params.new)) {
			const identity = cloneJson(params.new);
			this.noteUser(identity, 'profile');
			if (isIdentity(params.old) && params.old.user_id !== identity.user_id) {
				this.noteUser(cloneJson(params.old), 'history');
				this.userAliases.set(params.old.user_id, identity.user_id);
			}
		} else {
			return;
		}
		this.emit();
	}

	/**
	 * Keeps the latest user object per `user_id` (§3.3). Profiles (`you`,
	 * `user`, `members`) replace it; a live `from` updates the name it
	 * carries and keeps the rest; a `from` in history or an embedded snapshot,
	 * which may be old, only introduces a user not seen yet.
	 */
	private noteUser(identity: Identity, source: 'profile' | 'live' | 'history'): void {
		const current = this.users.get(identity.user_id);
		if (source === 'profile') {
			this.users.set(identity.user_id, { identity, profile: true });
		} else if (!current) {
			this.users.set(identity.user_id, { identity: { user_id: identity.user_id, ...(identity.name ? { name: identity.name } : {}) }, profile: false });
		} else if (source === 'live' && identity.name && identity.name !== current.identity.name) {
			this.users.set(identity.user_id, { identity: { ...current.identity, name: identity.name }, profile: current.profile });
		}
	}

	private readCursor(roomId: string): string | undefined {
		const you = this.you?.user_id;
		return you === undefined ? undefined : this.reads.get(roomId)?.get(you);
	}

	/** Keeps a read cursor only when it moves forward. */
	private setReadCursor(roomId: string, userId: string, messageId: string): boolean {
		let room = this.reads.get(roomId);
		if (!room) this.reads.set(roomId, room = new Map());
		const current = room.get(userId);
		if (current !== undefined && compareLogIds(messageId, current) <= 0) return false;
		room.set(userId, messageId);
		return true;
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
		for (const message of decoded.embedded) {
			this.noteUser(message.from, 'history');
			this.acceptLiveMessage(message, false);
		}
		this.emit();
	}

	private handleSnapshot(params: JsonObject | undefined): void {
		const decoded = decodeMessage(params);
		if (!decoded) return;
		this.noteUser(decoded.record.from, 'live');
		for (const embedded of decoded.embedded) this.noteUser(embedded.from, 'history');
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
			this.noteUser(set.from, 'live');
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
		for (const record of [...records.messages, ...records.embedded]) this.noteUser(record.from, 'history');
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
		this.users.clear();
		this.userAliases.clear();
		this.reads.clear();
		this.roomMembers.clear();
		this.directory = undefined;
		this.threadDirectory.clear();
	}

	private defaultRoomId(): string | undefined {
		for (const room of this.rooms.values()) if (!this.isThread(room.id)) return room.id;
		return this.rooms.keys().next().value;
	}

	/**
	 * An `activity` broadcast (Appendix D.1): present fields change the user's
	 * transient state, absent ones leave it. `typing` seconds show or refresh
	 * the indicator, `0` removes it. `read_message_id` moves that user's read
	 * cursor forward; yours places the New divider.
	 */
	private handleActivity(params: JsonObject | undefined): void {
		if (!params || typeof params.room_id !== 'string' || !isIdentity(params.from)) return;
		const room = params.room_id;
		const from = cloneJson(params.from);
		this.noteUser(from, 'live');
		const read = isLogId(params.read_message_id) && this.setReadCursor(room, from.user_id, params.read_message_id);
		const seconds = params.typing;
		if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
			if (read) this.emit();
			return;
		}
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

	/** Remembers that this browser has a passkey for this server, for `passkeyPlan`. */
	private passkeyHintKey(): string {
		return `apron.passkey:${this.serverUrl}`;
	}

	private loadPasskeyHint(): boolean {
		try {
			return this.sessionToken !== undefined || globalThis.localStorage?.getItem(this.passkeyHintKey()) === '1';
		} catch {
			return this.sessionToken !== undefined;
		}
	}

	/** Kept across sign-out: the passkey itself stays on the device. */
	private rememberPasskey(): void {
		this.passkeyHint = true;
		try {
			globalThis.localStorage?.setItem(this.passkeyHintKey(), '1');
		} catch {
			// Best effort; `passkeyPlan` then falls back to registering.
		}
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
/**
 * The latest user object for a `user_id`, following renames (§3.3): a
 * retired ID resolves to the identity that replaced it. Falls back to the
 * given `from`, so a message always has someone to show.
 */
export function userIn(snapshot: Pick<ClientSnapshot, 'users' | 'userAliases'>, from: Identity): Identity {
	let id = from.user_id;
	for (let hops = 0; hops < 8 && snapshot.userAliases[id] !== undefined; hops += 1) id = snapshot.userAliases[id];
	return snapshot.users[id] ?? snapshot.users[from.user_id] ?? from;
}

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
