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
	decodeMembership,
	decodeMessage,
	decodeNotice,
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
	type RoomDelivery,
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
 * A transient notice (PROTOCOL.md §3.5, Appendix A.1): a `message` without
 * `message_id`, such as a `@private` command reply, or a local one such as a
 * command's error. It shows in its room for the session and is never stored
 * as a snapshot, so it never takes part in replay.
 */
export interface Notice {
	/** Unique within the session. */
	key: string;
	room_id: string;
	from: Identity;
	body?: MessageBody;
	/**
	 * Where it sits in the room's timeline: after every message whose
	 * `message_id` is at most this position, the newest the room had when the
	 * notice arrived.
	 */
	after: string;
	/** When it arrived, in epoch milliseconds (notices carry no `log_id`). */
	at: number;
}

/**
 * One visible room: a room the user has joined on this connection (cap
 * `rooms`), else one a message arrived in, or a room opened without joining
 * it (`viewRoom`, `joined: false`). Threads are rooms with `parentRoomId`
 * (PROTOCOL.md §3.4, §4.3).
 */
export interface RoomSnapshot {
	id: string;
	/** Display title: the record's `title`, falling back to the `room_id`. */
	title: string;
	/**
	 * The user has joined it (or, without cap `rooms`, it is a room messages
	 * arrive in): it delivers live. A room opened with `viewRoom` is not joined
	 * and changes only when it loads.
	 */
	joined: boolean;
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
	/**
	 * A thread loaded newest-first has older records to fetch with
	 * `loadOlder`; its message count is a lower bound until they are.
	 */
	olderAvailable?: boolean;
	/** A `loadOlder` request is in flight. */
	loadingOlder?: boolean;
	/** Your read cursor in this room (§4.4), as the server last reported or you advanced it. */
	readMessageId?: string;
	/**
	 * The room's members (§4.3.2): started from a complete `members` listing
	 * (`room_list` with `members`, or `room_update` `joined`) and kept current by
	 * the memberships received live and in history. Each is the listed or
	 * recorded user object; render it through the kept one. Undefined until
	 * anything is known.
	 */
	members?: Identity[];
	/** Transient notices shown in this room this session, in arrival order. */
	notices: readonly Notice[];
}

/**
 * A visible room as `room_list` returns it (§4.3.1): its record, its head,
 * and its members. Listing a room does not join it.
 */
export interface RoomListing {
	id: string;
	title: string;
	record: RoomRecord;
	parentRoomId?: string;
	latestLogId?: string;
	historyLogId?: string | null;
	/** The room's members when the listing asked for them (`members: true`), else empty. */
	members: Identity[];
	/** The user has joined it: it is in the joined set on this connection. */
	joined: boolean;
}

/** The room a client posts to without naming one: the server's default room (§3.5), before its `room_id` is known. */
export const DEFAULT_ROOM_ID = '';

/** A file this client is writing to an embed's `write_url` (§4.6.3). */
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

/** A typing indicator shown for another user (§4.4). */
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
	/**
	 * Visible rooms in the order they were listed, joined, or opened (a
	 * `room_list` lists the most recently active first).
	 */
	rooms: RoomSnapshot[];
	activeRoom?: string;
	pending: PendingOperation[];
	typing: TypingSnapshot[];
	/**
	 * One kept user object per `user_id` (§3.3), merged field by field from
	 * every current object: `you`, `new` in `user`, and room `members` and
	 * `users`. Recorded objects (`from`, a membership's `user`) never merge
	 * into it. Render a user with `userIn`, which follows renames and falls
	 * back field by field to the recorded object the frame carries.
	 */
	users: Record<string, Identity>;
	/**
	 * The latest recorded object seen per `user_id` (a message's or
	 * reaction's `from`, a membership's `user`), by `log_id`. Never merged into
	 * `users`: a fallback where no frame carries one, such as a mention in
	 * text, and what tells apart users who share a display name.
	 */
	recordedUsers: Record<string, Identity>;
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
	/** The `user_id`s the message mentions (§3.5), sent as `body.mentions`. */
	mentions?: string[];
	ext?: JsonObject;
}

/**
 * Changes to a saved message. Absent keys keep the latest snapshot's value;
 * `null` removes `reply_to` or `ext`. Saves always resubmit every client field
 * (§4.2).
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

/**
 * How a room is in the client's rooms: `joined` (visible and live; without cap
 * `rooms`, any room messages arrive in), `viewed` (opened without joining,
 * loaded through history only), or `pending` (kept from the last connection
 * and resuming its recovery while the new connection's `room_list` decides
 * whether it is still joined; not visible).
 */
type RoomKind = 'joined' | 'viewed' | 'pending';

interface RoomState {
	id: string;
	kind: RoomKind;
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
	/**
	 * Kept from an earlier connection: a thread's records after T are not
	 * loaded yet, so it reports unloaded until the next `loadRoom` catches up.
	 */
	resumed?: boolean;
	/**
	 * A thread loaded newest-first: the `first_log_id` of its oldest loaded
	 * page, below which `loadOlder` pages backward while `hasOlder`.
	 */
	olderBefore?: string;
	hasOlder?: boolean;
	loadingOlder?: boolean;
	loadGeneration: number;
	loading: boolean;
	/** The published timeline; rebuilt from the store when dirty and not recovering. */
	timeline: TimelineState;
	dirty: boolean;
	/** The connection on which a room without a record last recovered from a message's position. */
	recoveredOn?: number;
}

function newRoomState(id: string, kind: RoomKind = 'joined'): RoomState {
	return { id, kind, recoveryGeneration: 0, waiters: [], loadGeneration: 0, loading: false, timeline: createTimeline(id), dirty: true };
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
	/**
	 * Fixed H for the whole recovery. A recovery sent right behind `auth`,
	 * before any room record is known, starts without it and takes it from its
	 * first page's `latest_log_id` (§4.1 recovery, step 1).
	 */
	head?: string;
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
	more: boolean;
	latest_log_id: string;
	history_log_id: string | null;
};

const REQUEST_TIMEOUT_MS = 20_000;
const HISTORY_PAGE_SIZE = 200;
/** A thread opens on its newest page this size; older pages load as the reader scrolls back. */
const THREAD_PAGE_SIZE = 50;
const MAX_RECONNECT_DELAY_MS = 60_000;
/** How long a typing indicator this client sends should persist without a refresh, in the `activity` frame's `typing` seconds. */
const TYPING_TIMEOUT_S = 15;
/** The longest a received typing indicator is shown without a refresh. */
const MAX_TYPING_S = 300;
/** How often the indicator is refreshed while typing continues: well inside the timeout, and far from one frame per keystroke. */
const TYPING_REFRESH_MS = 12_000;
/** The liveness ping (§1), sent as these exact bytes so a server can answer without parsing. */
const PING_FRAME = '{"method":"ping"}';
/** Pings a socket may leave unanswered for a whole interval before it is presumed dead. */
const MAX_UNANSWERED_PINGS = 1;
/**
 * How long a connection must stay authenticated before the reconnect backoff
 * starts over. Resetting on auth alone let a server that closes right after
 * auth be reconnected to every half second, each time paying for a new session.
 */
const STABLE_CONNECTION_MS = 30_000;
/** How long a `room_list` result is reused for the same parent unless the caller asks for fresher. */
const ROOM_LIST_REUSE_MS = 10_000;
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
const CAPABILITIES: Capability[] = ['history', 'edit', 'rooms', 'reactions', 'activity', 'embed:upload', 'embed:stream', 'command'];

/**
 * A browser-only Apron protocol v6 session; instantiate one per mounted UI.
 *
 * State model: one store of room records, message snapshots, reaction sets,
 * and memberships shared by every room (PROTOCOL.md §2), projected per visible
 * room in `snapshot().rooms`. With cap `rooms` the visible rooms are the
 * joined set, listed with `room_list` right behind `auth` (§3.2) and kept
 * current by `room_update`; without it they are the rooms messages arrive in.
 * Top-level rooms recover history automatically when they become visible (cap
 * `history`); threads are rooms with a parent and load their history with
 * `loadRoom` when opened, joined or not (`viewRoom`). Mutations return an
 * `OperationHandle` that settles on the server's reply; the authoritative state
 * arrives as the notifications the request caused, which the server sends
 * before the reply (§1), though nothing here depends on that order.
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
	/** One kept user object per `user_id` (§3.3), merged from current objects only. */
	private readonly users = new Map<string, Identity>();
	/** The latest recorded object per `user_id` and the `log_id` of the record that carried it. */
	private readonly recordedUsers = new Map<string, { identity: Identity; log_id: string }>();
	private readonly userAliases = new Map<string, string>();
	/** The greatest `log_id` this client has received: where a notice sits in its room's timeline. */
	private greatestLogId?: string;
	/** Read cursors per room, per user (§4.4). */
	private readonly reads = new Map<string, Map<string, string>>();
	private readonly uploads = new Map<string, UploadState>();
	/** Transient notices per room, for the session (§3.5). */
	private readonly notices = new Map<string, Notice[]>();
	/** Notices that arrived before there was a room to show them in; the first room shown takes them. */
	private orphanNotices: Array<{ from: Identity; body?: MessageBody }> = [];
	private noticeCount = 0;
	/** Nobody is attending this connection (§4.4); `awaySent` is what the server was last told on it. */
	private away = false;
	private awaySent = false;
	/** The `room_id` of the server's default room once known (without cap `rooms`). */
	private defaultRoom?: string;
	/** Messages this client posted without `room_id`: their broadcast names the default room. */
	private readonly defaultPosts = new Set<string>();
	/**
	 * Rooms kept from a lost connection with their records, floors and
	 * checkpoints. Hidden until joined again on the next connection, when
	 * recovery resumes from the checkpoint instead of paging all retained
	 * history (§4.1).
	 */
	private readonly retainedRooms = new Map<string, RoomState>();
	/**
	 * The joined rooms kept from the last connection were its whole joined set
	 * (its `room_list` arrived): a reconnect as the same identity may then list
	 * only what changed since their checkpoints (`latest_log_id`, §4.3.1).
	 */
	private joinedComplete = false;
	/** The identity whose joined rooms are kept from the last connection. */
	private keptUserId?: string;
	private directory?: RoomListing[];
	private readonly threadDirectory = new Map<string, RoomListing[]>();
	/**
	 * The latest `room_list` per listing (`''` for rooms to browse, a parent's
	 * `room_id` for its threads, `#` and a `room_id` for its members), shared
	 * while in flight and reused while recent.
	 */
	private readonly listings = new Map<string, { at: number; promise: Promise<RoomListing[]>; rooms?: Set<string> }>();
	/**
	 * The `room_list` of joined rooms on this connection (cap `rooms`), until
	 * its result arrives; `since` and `userId` when it lists only changes since
	 * a position, for that identity.
	 */
	private joinedListing?: { id: string; since?: string; userId?: string };
	private socket?: WebSocket;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private pingTimer?: ReturnType<typeof setInterval>;
	/** Resets the reconnect backoff once the current connection has stayed up. */
	private stableTimer?: ReturnType<typeof setTimeout>;
	/** Resumes connecting when the page is shown or the network returns; set while waiting for either. */
	private presenceWaiter?: () => void;
	/** Pings sent on the current socket since its last `pong`. */
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
	/** A name the server denied (a guest on a server that only lets registered users rename): not resent on reconnect. */
	private declinedName?: string;
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
		const name = this.displayName;
		const request = this.enqueueRequest('me', { name }, {
			visible: false,
			allowBeforeAuth: false
		});
		request.promise
			.then((result) => {
				if (isJsonObject(result.you) && typeof result.you.user_id === 'string') this.setYou(result.you as Identity);
				if (this.declinedName === name) this.declinedName = undefined;
				this.emit();
			})
			.catch((cause: Error & { code?: number }) => {
				// A name is advisory; a server may decline it without affecting the session.
				if (cause.code === -32001) this.declinedName = name;
			});
		return request;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.reconnectHeld = false;
		this.showReconnectDivider = this.reconnectAttempt > 0;
		if (this.waitForPresence()) return;
		this.connectNow();
	}

	stop(): void {
		this.connectionProbe?.abort();
		this.cancelPasskey();
		this.running = false;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.stopWaitingForPresence();
		this.clearStableTimer();
		const socket = this.socket;
		this.socket = undefined;
		this.authenticated = false;
		this.authRequested = false;
		this.clearTyping();
		this.stopPing();
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
		if (this.rooms.has(roomId) && this.rooms.get(roomId)!.kind !== 'pending') {
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
			rooms: this.orderedRooms().map((room) => {
				if (room.dirty && !room.recovery) {
					room.timeline = this.store.timeline(room.id, this.you?.user_id);
					room.dirty = false;
				}
				const record = this.store.room(room.id);
				const thread = typeof record?.parent_room_id === 'string';
				const intro = record?.intro_message ? this.store.message(record.intro_message.message_id) : undefined;
				const renames = this.store.roomRenames(room.id);
				const members = this.store.members(room.id);
				return {
					id: room.id,
					title: roomTitle(room.id, record),
					joined: room.kind === 'joined',
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
					loaded: !history || (this.loadsOnOpen(room) ? this.threadLoaded(room) : room.checkpoint !== undefined),
					loading: room.loading,
					...(this.hasOlderRecords(room) ? { olderAvailable: true } : {}),
					...(room.loadingOlder ? { loadingOlder: true } : {}),
					...(this.readCursor(room.id) !== undefined ? { readMessageId: this.readCursor(room.id) } : {}),
					...(members ? { members } : {}),
					notices: this.notices.get(room.id) ?? NO_NOTICES
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
			users: Object.fromEntries(this.users),
			recordedUsers: Object.fromEntries([...this.recordedUsers].map(([id, entry]) => [id, entry.identity])),
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
	 * message in any room and is sent as a bare reference; `mentions` lists
	 * the users it mentions. Room `DEFAULT_ROOM_ID` posts without `room_id`, to
	 * the server's default room. A message with no text and no embeds is not
	 * sent (§3.5).
	 */
	send(room: string, text: string, format: MessageFormat = 'plain', options: SendOptions = {}): OperationHandle<MessageResult> {
		if (!text && !options.embeds?.length) return rejectedHandle('message', new Error('Nothing to send'));
		// The message ends this user's typing indicator for everyone (§4.4), and
		// any `away`, so no `typing: 0` needs to follow it.
		this.sentTypingAt.delete(room);
		this.awaySent = false;
		const handle = this.enqueueRequest<MessageResult>('message', this.messageParams(room, text, format, options), { visible: true, allowBeforeAuth: false });
		if (room === DEFAULT_ROOM_ID) {
			handle.promise.then((result) => {
				if (isLogId(result.message_id)) this.defaultPosts.add(result.message_id);
				// The broadcast may have come first.
				const posted = isLogId(result.message_id) ? this.store.message(result.message_id) : undefined;
				if (posted) this.learnDefaultRoom(posted.room_id);
			}, () => undefined);
		}
		return handle;
	}

	/** The params of a new message or a command: `room_id`, `body`, bare `reply_to`, `ext` (§3.5, §4.8). */
	private messageParams(room: string, text: string, format: MessageFormat | undefined, options: SendOptions): JsonObject {
		const body: JsonObject = { text, ...(format ? { format } : {}) };
		if (options.embeds && options.embeds.length > 0) body.embeds = options.embeds;
		const mentions = [...new Set(options.mentions ?? [])];
		if (mentions.length > 0) body.mentions = mentions;
		return {
			...(room !== DEFAULT_ROOM_ID ? { room_id: room } : {}),
			body,
			...(options.replyTo !== undefined ? { reply_to: { message_id: options.replyTo } } : {}),
			...(options.ext !== undefined ? { ext: options.ext } : {})
		};
	}

	/**
	 * Sends a `command` (cap `command`, §4.8): `text` is the command line as
	 * typed, slash included, with the params a message would have; mentions,
	 * `replyTo`, and embeds are arguments. Nothing is posted: the result is
	 * `{}` (or `embeds` with write URLs), replies come as notices, and effects
	 * as the frames they cause. A failure rejects with the server's message.
	 */
	command(room: string, text: string, options: Omit<SendOptions, 'ext'> = {}): OperationHandle {
		this.awaySent = false;
		return this.enqueueRequest('command', this.messageParams(room, text, undefined, options), { visible: true, allowBeforeAuth: false });
	}

	/**
	 * Shows a transient notice in a room for this session (§3.5), such as a
	 * command's error: from `@private` ("Only you"), never sent or stored.
	 */
	notify(room: string, text: string): void {
		this.addNotice(room, { user_id: '@private', name: 'Only you' }, { text });
		this.emit();
	}

	/**
	 * Saves a message (cap `edit`, §4.2) from its latest stored snapshot:
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
	 * Sets your complete emoji set on a message (cap `reactions`,
	 * §4.5); `[]` clears it. The result is `{}`; the broadcast carries the state.
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
	 * Creates a room with `room_set` (cap `rooms`, §4.3.4), which joins the
	 * creator; with `parentRoomId` it is a thread, usually with the parent
	 * message that started it as `introMessageId`. Resolves with the new
	 * `room_id`; the room record arrives in a `room_update`.
	 */
	createRoom(options: CreateRoomOptions = {}): OperationHandle<RoomResult> {
		const params: JsonObject = {};
		if (options.parentRoomId !== undefined) params.parent_room_id = options.parentRoomId;
		if (options.title !== undefined) params.title = options.title;
		if (options.introMessageId !== undefined) params.intro_message = { message_id: options.introMessageId };
		if (options.ext !== undefined) params.ext = options.ext;
		return this.enqueueRequest<RoomResult>('room_set', params, { visible: true, allowBeforeAuth: false });
	}

	/**
	 * Updates a room's client fields with `room_set` (§4.3.4) from its latest
	 * record with the patch applied, resubmitting `title`, a bare
	 * `intro_message`, and `ext`: omitted fields are cleared.
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
		const handle = this.enqueueRequest<RoomResult>('room_set', params, { visible: true, allowBeforeAuth: false });
		const { room_id: _id, ...state } = params;
		this.trackSave(this.pendingRoomSaves, roomId, handle, state, () => this.store.room(roomId)?.log_id);
		return handle;
	}

	/** `room_join` (§4.3.2): the room arrives in a `room_update` `joined` and becomes visible. */
	joinRoom(roomId: string): OperationHandle {
		return this.enqueueRequest('room_join', { room_id: roomId }, { visible: true, allowBeforeAuth: false });
	}

	/** `room_leave` (§4.3.2): the room goes when a `room_update` lists it in `left`. */
	leaveRoom(roomId: string): OperationHandle {
		return this.enqueueRequest('room_leave', { room_id: roomId }, { visible: true, allowBeforeAuth: false });
	}

	/**
	 * Reports typing in a room as an `activity` notification (cap `activity`,
	 * §4.4): `typing` seconds while active, `0` to stop. Sends nothing
	 * to a server without the cap.
	 */
	sendTyping(room: string, active: boolean): void {
		if (room === DEFAULT_ROOM_ID || !this.authenticated || !this.hasCap('activity') || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
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
		// Typing ends `away` on the server (§4.4).
		this.awaySent = false;
	}

	/**
	 * Tells the server whether anyone is attending this connection (cap
	 * `activity`, §4.4): `true` while the tab is hidden or unfocused, `false`
	 * once it is back. Sent only when it changes, and again on each connection
	 * that starts while away.
	 */
	setAway(away: boolean): void {
		this.away = away;
		this.syncAway();
	}

	private syncAway(): void {
		if (!this.authenticated || !this.hasCap('activity') || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
		if (this.away === this.awaySent) return;
		this.awaySent = this.away;
		this.sendFrame({ method: 'activity', params: { away: this.away } });
	}

	/**
	 * Advances your read cursor in a room (cap `activity`, §4.4) to a
	 * message, if that is further than the cursor already is. The server
	 * syncs it to your other connections.
	 */
	markRead(roomId: string, messageId: string): void {
		if (roomId === DEFAULT_ROOM_ID || !this.authenticated || !this.hasCap('activity') || !isLogId(messageId)) return;
		const current = this.readCursor(roomId);
		if (current !== undefined && compareLogIds(messageId, current) <= 0) return;
		this.setReadCursor(roomId, this.you!.user_id, messageId);
		// The cursor still moves here (it places the New divider); a server that
		// keeps no read cursors would only be charged a frame for it.
		if (this.server?.ext?.demo?.read_cursors !== false) {
			this.sendFrame({ method: 'activity', params: { room_id: roomId, read_message_id: messageId } });
			// A read cursor ends `away` on the server (§4.4).
			this.awaySent = false;
		}
		this.emit();
	}

	/** Visible rooms in the order they were listed, joined, or opened. */
	private orderedRooms(): RoomState[] {
		return [...this.rooms.values()].filter((room) => room.kind !== 'pending');
	}

	/**
	 * Lists visible rooms the user has not joined (cap `rooms`, §4.3.1):
	 * top-level rooms with their members, or with `parentRoomId` that room's
	 * threads, whose heads refresh the cards of threads not joined (they
	 * deliver nothing live). The result also lands in the snapshot's
	 * `directory` or `threadDirectory`. Servers may list only the most active
	 * rooms, so neither is complete.
	 */
	listRooms(parentRoomId?: string, maxAgeMs = ROOM_LIST_REUSE_MS): Promise<RoomListing[]> {
		const params: JsonObject = parentRoomId !== undefined
			? { parent_room_id: parentRoomId, filter: 'not_joined' }
			: { filter: 'not_joined', members: true };
		return this.cachedListing(parentRoomId ?? '', params, maxAgeMs, (listed) => {
			if (parentRoomId === undefined) this.directory = listed.not_joined;
			else this.threadDirectory.set(parentRoomId, listed.not_joined);
			return listed.not_joined;
		});
	}

	/**
	 * Lists one room with its members (`room_list` with `room_id` and
	 * `members`, §4.3.1), which then show in the room's snapshot as `members`
	 * and stay current by memberships. Joined rooms have them from their
	 * listing already; this is for a room opened without joining.
	 */
	listMembers(roomId: string, maxAgeMs = ROOM_LIST_REUSE_MS): Promise<RoomListing[]> {
		return this.cachedListing(`#${roomId}`, { room_id: roomId, members: true }, maxAgeMs, (listed) => [...listed.joined, ...listed.not_joined]);
	}

	/**
	 * Listing is costly on some servers and rate limited on most, and several
	 * parts of the UI want it at once: a request in flight, or one answered
	 * within `maxAgeMs`, serves them all.
	 */
	private cachedListing(
		key: string, params: JsonObject, maxAgeMs: number, pick: (listed: { joined: RoomListing[]; not_joined: RoomListing[] }) => RoomListing[]
	): Promise<RoomListing[]> {
		const recent = this.listings.get(key);
		if (recent && Date.now() - recent.at < maxAgeMs) return recent.promise.then((listings) => listings.map((listing) => this.withJoined(listing)));
		const promise = this.enqueueRequest('room_list', params, { visible: false, allowBeforeAuth: false }).promise.then((result) => {
			const listings = pick(this.applyRoomList(result, false));
			this.emit();
			return listings;
		});
		const entry: { at: number; promise: Promise<RoomListing[]>; rooms?: Set<string> } = { at: Date.now(), promise };
		this.listings.set(key, entry);
		promise.then((listings) => {
			entry.rooms = new Set(listings.map((listing) => listing.id));
		}, () => {
			if (this.listings.get(key) === entry) this.listings.delete(key);
		});
		return promise.then((listings) => listings.map((listing) => this.withJoined(listing)));
	}

	/**
	 * Lists every room the user has joined, threads included, with their
	 * members (`room_list` with `filter: "joined"` and `members`, §4.3.1): the
	 * result becomes the visible set, each room recovering its history as it
	 * appears, and `room_update` keeps it current from then on. It may go
	 * right behind `auth`, which finishes first (§3.2). With `since`, the
	 * server lists only rooms whose log moved past it, plus the ones left in
	 * `left`; rooms it leaves out are unchanged.
	 */
	private listJoinedRooms(since?: string): void {
		const socket = this.socket;
		const params: JsonObject = { filter: 'joined', members: true, ...(since !== undefined ? { latest_log_id: since } : {}) };
		const request = this.enqueueRequest('room_list', params, { visible: false, allowBeforeAuth: true });
		const listing = { id: request.id, ...(since !== undefined ? { since, ...(this.keptUserId !== undefined ? { userId: this.keptUserId } : {}) } : {}) };
		this.joinedListing = listing;
		this.joinedComplete = false;
		request.promise.then((result) => {
			if (socket !== this.socket || this.joinedListing !== listing) return;
			this.joinedListing = undefined;
			if (listing.since !== undefined && this.you?.user_id !== listing.userId) {
				// Another identity than the kept rooms': what changed since is someone else's story.
				this.listJoinedRooms();
				this.emit();
				return;
			}
			this.applyRoomList(result, true);
			this.joinedComplete = true;
			this.emit();
		}, (cause: Error) => {
			if (socket !== this.socket || this.joinedListing !== listing) return;
			this.joinedListing = undefined;
			// Behind a failed `auth` every request is denied; that failure speaks for itself.
			if (this.authenticated) this.error = `Unable to list your rooms: ${cause.message}`;
			this.emit();
		});
	}

	/**
	 * Applies a `room_list` result (§4.3.1): its rooms' records, members and
	 * embedded snapshots, and the result's `users`. For the listing of joined
	 * rooms (`joinedSet`) its `joined` becomes the visible set: with `left`,
	 * a listing of changes, the rooms in it go and every other kept room stays;
	 * without, a full listing, every other joined room goes.
	 */
	private applyRoomList(result: JsonObject, joinedSet: boolean): { joined: RoomListing[]; not_joined: RoomListing[] } {
		const listed = { joined: [] as RoomListing[], not_joined: [] as RoomListing[] };
		const joinedIds = new Set<string>();
		for (const [key, joined] of [['joined', true], ['not_joined', false]] as const) {
			const values = result[key];
			for (const value of Array.isArray(values) ? values : []) {
				const decoded = decodeRoom(value);
				if (!decoded) continue;
				const record = decoded.record;
				this.observeLogId(decoded.delivery.latest_log_id);
				this.noteMembers(record.room_id, decoded.delivery);
				if (joined && joinedSet) {
					joinedIds.add(record.room_id);
					this.showRoom(decoded, 'joined');
				} else if (this.rooms.has(record.room_id)) {
					// Its record and delivery fields are the latest (§3.4); for a room
					// opened without joining, the head is what the next load reaches.
					this.showRoom(decoded);
				} else {
					this.installRoom(record);
					for (const message of decoded.embedded) this.installEmbedded(message);
				}
				listed[key].push({
					id: record.room_id,
					title: roomTitle(record.room_id, record),
					record,
					...(record.parent_room_id !== undefined ? { parentRoomId: record.parent_room_id } : {}),
					...(decoded.delivery.latest_log_id !== undefined ? { latestLogId: decoded.delivery.latest_log_id } : {}),
					...(Object.hasOwn(decoded.delivery, 'history_log_id') ? { historyLogId: decoded.delivery.history_log_id } : {}),
					members: decoded.delivery.members ?? [],
					joined
				});
			}
		}
		if (joinedSet) {
			if (Array.isArray(result.left)) {
				// Changes since `latest_log_id`: rooms left since then go; the others kept are unchanged.
				for (const value of result.left) {
					if (isJsonObject(value) && typeof value.room_id === 'string') this.hideRoom(value.room_id);
				}
				for (const room of this.rooms.values()) if (room.kind === 'pending') this.markJoined(room);
			} else {
				// A full listing: `joined` is the whole set; anything else joined was left meanwhile.
				for (const room of [...this.rooms.values()]) {
					if (room.kind !== 'viewed' && !joinedIds.has(room.id) && room.id !== DEFAULT_ROOM_ID) this.hideRoom(room.id);
				}
			}
		}
		this.noteUsers(result.users);
		return listed;
	}

	/**
	 * A room's `members`, complete (§4.3.1, §4.3.3): current user objects,
	 * merged into the kept ones, that start its member list as of the room's
	 * `latest_log_id` in the same frame.
	 */
	private noteMembers(roomId: string, delivery: RoomDelivery): void {
		if (delivery.members === undefined) return;
		for (const member of delivery.members) this.noteUser(member);
		this.store.seedMembers(roomId, delivery.members, delivery.latest_log_id);
	}

	/** A frame's `users` (§3.3): complete current user objects. */
	private noteUsers(users: unknown): void {
		for (const user of Array.isArray(users) ? users : []) if (isIdentity(user)) this.noteUser(cloneJson(user));
	}

	/** Membership changed: listings of rooms and threads to join are stale. */
	private forgetListings(parentRoomId: string | undefined): void {
		this.listings.delete(parentRoomId ?? '');
	}

	private withJoined(listing: RoomListing): RoomListing {
		return { ...listing, joined: this.rooms.get(listing.id)?.kind === 'joined' };
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
	 * `embed:upload`, §4.6.4): the message goes out with one pending embed
	 * per file, then each file is written to the `write_url` the result lists.
	 * `sent` settles with the message result; `uploaded` when every write has
	 * finished. Progress and failures appear in the snapshot's `uploads`.
	 */
	sendFiles(
		room: string, text: string, files: File[], format: MessageFormat = 'plain', options: SendOptions = {}, command = false
	): { sent: Promise<JsonObject>; uploaded: Promise<void> } {
		const uploads: Embed[] = files.map((file) => ({ kind: 'upload', ...(file.name ? { title: file.name } : {}) }));
		const embeds = [...(options.embeds ?? []), ...uploads];
		// A command takes embeds as arguments, and its result lists their write URLs too (§4.6.3, §4.8).
		const handle: OperationHandle = command ? this.command(room, text, { ...options, embeds }) : this.send(room, text, format, { ...options, embeds });
		const uploaded = handle.promise.then((result) => this.writeUploads(result, files));
		return { sent: handle.promise, uploaded };
	}

	/**
	 * Uploads an image as your avatar (§4.6.6, caps `command` and
	 * `embed:upload`): a `/avatar` command with one upload embed, then the file
	 * written to the result's `write_url`. The server sets `avatar` and sends a
	 * `user` notification once the image is written.
	 */
	uploadAvatar(file: File): Promise<void> {
		const request = this.enqueueRequest('command', {
			body: { text: '/avatar', embeds: [{ kind: 'upload', ...(file.name ? { title: file.name } : {}) }] }
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
	 * Loads a room's history (§4.1). Threads and rooms opened without joining
	 * never recover automatically: call this when one is opened. It loads the
	 * newest page the first time, and afterwards pages from the previous load's
	 * checkpoint up to the head known at the call, resolving after the last
	 * page. For a joined top-level room, which recovers automatically, it waits
	 * for the running recovery, or retries one that failed. Without cap
	 * `history` it resolves at once.
	 */
	loadRoom(roomId: string): Promise<void> {
		const room = this.rooms.get(roomId);
		if (!room || room.kind === 'pending') return Promise.reject(new Error('Unknown room'));
		if (!this.hasCap('history')) return Promise.resolve();
		if (!this.loadsOnOpen(room)) {
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
		if (!head) {
			room.resumed = false;
			return;
		}
		const generation = ++room.loadGeneration;
		const stale = () => this.rooms.get(room.id) !== room || room.loadGeneration !== generation;
		room.loading = true;
		room.recoveryError = undefined;
		this.emit();
		try {
			if (room.loadCheckpoint === undefined) {
				// First load: only the newest page. Everything up to H is then
				// covered for live delivery, and older pages load on demand.
				const result = await this.enqueueRequest('history', { room_id: room.id, before: head, limit: THREAD_PAGE_SIZE }, {
					visible: false, allowBeforeAuth: false
				}).promise;
				if (stale()) return;
				if (!validHistoryMetadata(result)) throw new Error('Invalid history response');
				this.observeHistoryResponse(room, result);
				if (stale()) return;
				this.applyPage(room, result);
				this.noteOlderPage(room, result);
				room.loadCheckpoint = head;
				room.resumed = false;
				return;
			}
			let checkpoint: string | undefined = room.loadCheckpoint;
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
					room.resumed = false;
					return;
				}
				const lastId = result.last_log_id;
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

	/**
	 * Loads the page of a thread's history just before what is loaded, when a
	 * newest-first load left older records (§4.1, backward paging).
	 */
	async loadOlder(roomId: string): Promise<void> {
		const room = this.rooms.get(roomId);
		if (!room || room.loadingOlder || !this.hasOlderRecords(room) || room.olderBefore === undefined) return;
		const generation = room.loadGeneration;
		const stale = () => this.rooms.get(room.id) !== room || room.loadGeneration !== generation;
		room.loadingOlder = true;
		this.emit();
		try {
			const before = decrement(room.olderBefore);
			const result = await this.enqueueRequest('history', { room_id: room.id, before, limit: THREAD_PAGE_SIZE }, {
				visible: false, allowBeforeAuth: false
			}).promise;
			if (stale()) return;
			if (!validHistoryMetadata(result)) throw new Error('Invalid history response');
			this.observeHistoryResponse(room, result);
			if (stale()) return;
			this.applyPage(room, result);
			this.noteOlderPage(room, result);
		} finally {
			if (!stale()) room.loadingOlder = false;
			this.emit();
		}
	}

	/** Records where a backward page ended: its `first_log_id` bounds the next one. */
	private noteOlderPage(room: RoomState, result: ValidHistoryResponse): void {
		const first = isLogId(result.first_log_id) ? result.first_log_id : undefined;
		if (first !== undefined) room.olderBefore = first;
		room.hasOlder = result.more && first !== undefined;
	}

	/** Older records remain above the room's floor. */
	private hasOlderRecords(room: RoomState): boolean {
		if (!room.hasOlder || room.olderBefore === undefined) return false;
		return room.floor === undefined || compareLogIds(room.olderBefore, room.floor) > 0;
	}

	/**
	 * Opens a room the user has not joined, such as a thread from its card,
	 * without joining it: reading needs no membership (§4.1), and joining would
	 * log a membership for everyone (§4.3.2). It shows in the snapshot with
	 * `joined: false` and loads with `loadRoom`, but nothing about it arrives live
	 * until it is joined, so its head moves only when a listing (`listRooms`
	 * with its parent) reports a newer one. Its record and head come from the
	 * latest listing that named it. Returns false for a room nothing has listed.
	 */
	viewRoom(roomId: string): boolean {
		if (this.rooms.get(roomId)?.kind === 'joined' || this.rooms.get(roomId)?.kind === 'viewed') return true;
		const listing = [...(this.directory ?? []), ...[...this.threadDirectory.values()].flat()].find((known) => known.id === roomId);
		const record = listing?.record ?? this.store.room(roomId);
		if (!record) return false;
		if (this.rooms.get(roomId)?.kind === 'pending') return false;
		const room = this.adoptRetainedRoom(roomId) ?? newRoomState(roomId, 'viewed');
		room.kind = 'viewed';
		this.rooms.set(roomId, room);
		this.installRoom(record);
		this.observeHead(room, listing?.latestLogId);
		if (listing && listing.historyLogId !== undefined) this.observeBoundary(room, listing.historyLogId, listing.latestLogId ?? room.latestLogId);
		this.emit();
		return true;
	}

	/** Rooms that load with `loadRoom` when opened instead of recovering on their own: threads, and rooms not joined. */
	private loadsOnOpen(room: RoomState): boolean {
		return room.kind === 'viewed' || this.isThread(room.id);
	}

	/**
	 * A room that loads on open is loaded when a load reached its checkpoint on
	 * this connection: a joined one stays current live from there, one opened
	 * without joining only until a listing reports a newer head.
	 */
	private threadLoaded(room: RoomState): boolean {
		if (room.loadCheckpoint === undefined || room.resumed) return false;
		return room.kind === 'joined' || room.latestLogId === undefined || compareLogIds(room.latestLogId, room.loadCheckpoint) <= 0;
	}

	private connectNow(): void {
		if (!this.running || this.socket) return;
		this.stopWaitingForPresence();
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
			this.stopPing();
			this.clearStableTimer();
			// The protocol view is rebuilt from the next connection's room_list
			// (PROTOCOL.md §4.3.1; see tests/fixtures/wire/session), but each room's
			// records and checkpoint are kept so it resumes where it stopped. The
			// UI keeps the last authenticated view on screen meanwhile, keyed off
			// disconnectedAt.
			this.suspendProtocolView('Connection closed');
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
			try { socket.close(4000, 'ping unanswered'); } catch { /* already closed */ }
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
			case 'room_update':
				this.handleRoomUpdate(frame.params);
				return;
			case 'message':
				this.handleSnapshot(frame.params);
				return;
			case 'reactions':
				this.handleReactions(frame.params);
				return;
			case 'membership':
				this.handleMembership(frame.params);
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
		const previousPing = this.server?.ping;
		this.server = {
			protocol: params.protocol,
			...(typeof params.name === 'string' ? { name: params.name } : {}),
			caps: Array.isArray(params.caps) ? params.caps.filter(isString) : [],
			auth,
			...(isJsonObject(params.ext) ? { ext: params.ext as ServerExt } : {}),
			...(typeof params.ping === 'number' && Number.isFinite(params.ping) && params.ping > 0 ? { ping: params.ping } : {})
		};
		// Liveness starts before authentication (§1); a replacing frame may change the interval.
		if (!this.pingTimer || previousPing !== this.server.ping) this.startPing();
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
			client: 'apron-web/0.3'
		}, { visible: false, allowBeforeAuth: true });
		// `auth` is a barrier (§3.2): the server finishes it before reading on, so
		// the rooms and their recovery go right behind it instead of waiting a
		// round trip. If it fails they are denied, and that is all.
		this.requestRooms(resume);
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
		// The backoff starts over only once this connection has stayed up.
		this.clearStableTimer();
		const stableSocket = this.socket;
		this.stableTimer = setTimeout(() => {
			this.stableTimer = undefined;
			if (this.socket === stableSocket && this.authenticated) this.reconnectAttempt = 0;
		}, STABLE_CONNECTION_MS);
		this.disconnectedAt = undefined;
		// A reconnect keeps each room's records, and a server with cap `history`
		// fills the gap through recovery; only a session-only scrollback (§4
		// fallback) has a real gap to mark.
		this.showReconnectDivider = (this.showReconnectDivider || this.rooms.size > 0) && !this.hasCap('history');
		// Requests queued while this connection was authenticating go out now.
		for (const request of this.requests.values()) this.sendRequest(request);
		// Renaming is a logged mutation on some servers: send the saved name only
		// when the server doesn't already have it, and not again after it was
		// denied, unless this sign-in is a registered one that may now be allowed.
		const registered = passkey || typeof result.token === 'string';
		const name = this.displayName;
		const wanted = Boolean(name) && name !== this.you?.name && (registered || this.declinedName !== name);
		this.authNameRequest = wanted ? this.sendName() : undefined;
		// Rooms come by request (§4.3.1), usually already sent behind `auth`;
		// without cap `rooms` there is the default room.
		if (this.hasCap('rooms')) {
			if (!this.joinedListing) this.requestRooms(false);
		} else if (!this.rooms.size) {
			this.showDefaultRoom();
		}
		this.awaySent = false;
		this.syncAway();
		this.emit();
		return true;
	}

	/**
	 * Asks for the joined rooms (cap `rooms`) and resumes the rooms kept from
	 * the last connection: those opened without joining come back as they
	 * were, and joined ones wait, hidden, for the listing to say whether they
	 * still are, while their recovery (cap `history`) already pages forward
	 * from their checkpoints (§4.1). `sameIdentity`: this sign-in resumes the
	 * kept rooms' identity, so the listing may ask only for what changed since
	 * the rooms' checkpoints (§4.3.1).
	 */
	private requestRooms(sameIdentity: boolean): void {
		if (!this.hasCap('rooms')) return;
		const since = sameIdentity ? this.keptPosition() : undefined;
		this.listJoinedRooms(since);
		for (const [roomId, kept] of [...this.retainedRooms]) {
			if (this.rooms.has(roomId)) continue;
			const room = this.adoptRetainedRoom(roomId)!;
			this.rooms.set(roomId, room);
			if (kept.kind === 'viewed') continue;
			room.kind = 'pending';
			if (this.recoversAutomatically(room) && room.checkpoint !== undefined && !room.recovery) this.startRecovery(room, undefined, false);
		}
	}

	/**
	 * Where every joined room kept from the last connection is known to be
	 * complete: its recovery checkpoint (a room that recovers) or its head (a
	 * thread, which delivers live and loads on open). Undefined when a listing of
	 * changes since would not do: nothing kept, the kept set incomplete, or a
	 * room without such a position.
	 */
	private keptPosition(): string | undefined {
		if (!this.joinedComplete || !this.hasCap('history') || this.keptUserId === undefined) return undefined;
		let position: string | undefined;
		for (const room of this.retainedRooms.values()) {
			if (room.kind === 'viewed') continue;
			const synced = this.isThread(room.id) ? room.latestLogId : room.recoveryError ? undefined : room.checkpoint;
			if (synced === undefined) return undefined;
			if (position === undefined || compareLogIds(synced, position) < 0) position = synced;
		}
		return position;
	}

	/**
	 * Sends `{"method":"ping"}` every `server.ping` seconds for as long as this
	 * socket is current (§1), before authentication too; the server answers
	 * `pong`. When a ping has gone a whole interval without an answer, the
	 * socket is presumed dead and replaced. Counting pings rather than time
	 * means a tab whose timers were frozen probes again after it wakes instead
	 * of dropping a socket that may still work.
	 */
	private startPing(): void {
		this.stopPing();
		const seconds = this.server?.ping;
		const socket = this.socket;
		if (!socket || seconds === undefined) return;
		const interval = Math.max(1, seconds) * 1_000;
		this.unansweredPings = 0;
		const timer = setInterval(() => {
			if (socket === this.socket && socket.readyState === WebSocket.OPEN) {
				if (this.unansweredPings < MAX_UNANSWERED_PINGS) {
					socket.send(PING_FRAME);
					this.unansweredPings += 1;
					return;
				}
				this.abandonSocket?.();
			}
			clearInterval(timer);
			if (this.pingTimer === timer) this.pingTimer = undefined;
		}, interval);
		this.pingTimer = timer;
	}

	private stopPing(): void {
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.pingTimer = undefined;
	}

	private setYou(identity: Identity): void {
		const changed = this.you?.user_id !== identity.user_id;
		this.you = this.noteUser(identity);
		// `mine` in every reaction summary depends on the viewer.
		if (changed) for (const room of this.rooms.values()) room.dirty = true;
	}

	/**
	 * A `user` notification (§3.3), about identity only: `you` merges into
	 * this connection's identity, and a new `user_id` there brings its own
	 * rooms; `new` is another user's current object, and with `old` the old
	 * `user_id` now stands for the new identity. Joins and leaves are
	 * memberships, not `user` notifications.
	 */
	private handleUser(params: JsonObject | undefined): void {
		if (!params) return;
		if (isIdentity(params.you)) {
			const previous = this.you?.user_id;
			this.setYou(cloneJson(params.you));
			// The connection now acts as another identity, with its own rooms (§3.3).
			if (previous !== undefined && previous !== params.you.user_id && this.authenticated && this.hasCap('rooms')) this.listJoinedRooms();
		} else if (isIdentity(params.new)) {
			const current = this.noteUser(cloneJson(params.new));
			if (isIdentity(params.old) && params.old.user_id !== current.user_id) this.userAliases.set(params.old.user_id, current.user_id);
		} else {
			return;
		}
		this.emit();
	}

	/**
	 * A `membership` record (§4.3.2): one entry per user, each replacing that
	 * user's membership of the room when newer. It advances the room's head.
	 * Its `user` is a recorded object: never merged into the kept one.
	 */
	private handleMembership(params: JsonObject | undefined): void {
		const entries = decodeMembership(params);
		if (!entries.length) return;
		const { log_id: logId, room_id: roomId } = entries[0];
		this.observeLogId(logId);
		const room = this.rooms.get(roomId);
		if (room) this.observeHead(room, logId);
		for (const entry of entries) {
			this.noteRecorded(entry.user, logId);
			this.store.putMembership(entry);
		}
		this.emit();
	}

	/**
	 * Merges a current user object (`you`, `new`, room `members` and `users`)
	 * into the one kept for its `user_id` (§3.3), field by field: a present
	 * field replaces, an empty one (`""`, `{}`) removes, and a missing one is
	 * left alone. Returns the kept object, which is replaced only when it
	 * changes.
	 */
	private noteUser(identity: Identity): Identity {
		const current = this.users.get(identity.user_id);
		const merged = mergeIdentity(current, identity);
		if (merged !== current) this.users.set(identity.user_id, merged);
		if (this.you?.user_id === identity.user_id) this.you = merged;
		return merged;
	}

	/**
	 * Remembers the latest recorded object of a user (a `from`, a membership's
	 * `user`) by its record's `log_id`, apart from the kept one: a fallback
	 * where no frame carries one, and what tells apart users sharing a name.
	 */
	private noteRecorded(identity: Identity, logId: string): void {
		const current = this.recordedUsers.get(identity.user_id);
		if (current && compareLogIds(logId, current.log_id) <= 0) return;
		const same = current !== undefined && canonicalJson(current.identity) === canonicalJson(identity);
		this.recordedUsers.set(identity.user_id, { identity: same ? current.identity : identity, log_id: logId });
	}

	/** Remembers the greatest `log_id` received: where a notice sits in its room's timeline. */
	private observeLogId(logId: unknown): void {
		if (isLogId(logId) && (this.greatestLogId === undefined || compareLogIds(logId, this.greatestLogId) > 0)) this.greatestLogId = logId;
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

	/** Automatic recovery applies to joined top-level rooms when the server keeps history. */
	private recoversAutomatically(room: RoomState): boolean {
		return this.hasCap('history') && !this.loadsOnOpen(room);
	}

	/**
	 * A `room_update` (§4.3.3): `joined` rooms become visible with their
	 * members and recover, `updated` records replace a visible room's (or
	 * describe a new or edited thread of one), and `left` rooms go. `users`
	 * merges last.
	 */
	private handleRoomUpdate(params: JsonObject | undefined): void {
		if (!params) return;
		for (const value of Array.isArray(params.joined) ? params.joined : []) {
			const decoded = decodeRoom(value);
			if (!decoded) continue;
			this.observeLogId(decoded.delivery.latest_log_id);
			this.noteMembers(decoded.record.room_id, decoded.delivery);
			this.showRoom(decoded, 'joined');
		}
		for (const value of Array.isArray(params.updated) ? params.updated : []) {
			const decoded = decodeRoom(value);
			if (!decoded) continue;
			this.observeLogId(decoded.delivery.latest_log_id);
			this.noteMembers(decoded.record.room_id, decoded.delivery);
			if (this.rooms.has(decoded.record.room_id)) {
				this.showRoom(decoded);
			} else {
				this.installRoom(decoded.record);
				for (const message of decoded.embedded) this.installEmbedded(message);
				this.noteUnjoinedRoom(decoded.record, decoded.delivery);
			}
		}
		for (const value of Array.isArray(params.left) ? params.left : []) {
			if (isJsonObject(value) && typeof value.room_id === 'string') this.hideRoom(value.room_id);
		}
		this.noteUsers(params.users);
		this.emit();
	}

	/**
	 * Refreshes a room from its latest record frame, making it visible first
	 * as `kind` (a joined room's, or one opened without joining), or turning a
	 * room viewed or kept from the last connection into a joined one: installs
	 * the record, takes its delivery fields, and starts or resumes its
	 * automatic recovery (§4.1).
	 */
	private showRoom(decoded: { record: RoomRecord; embedded: MessageRecord[]; delivery: RoomDelivery }, kind?: 'joined'): void {
		const roomId = decoded.record.room_id;
		this.installRoom(decoded.record);
		const existing = this.rooms.get(roomId) ?? this.adoptRetainedRoom(roomId);
		if (!existing) this.forgetListings(decoded.record.parent_room_id);
		const room = existing ?? newRoomState(roomId, kind ?? 'joined');
		this.rooms.set(roomId, room);
		if (kind === 'joined') this.markJoined(room);
		const listedHead = decoded.delivery.latest_log_id;
		this.observeHead(room, listedHead);
		// Record the head before the bound so a new recovery captures it. An
		// active recovery keeps its original fixed head.
		if (Object.hasOwn(decoded.delivery, 'history_log_id')) {
			this.observeBoundary(room, decoded.delivery.history_log_id, listedHead ?? room.latestLogId);
		}
		this.recoverIfBehind(room, !existing);
		// Embedded snapshots install after the bound and any rebuild, so neither drops them.
		for (const message of decoded.embedded) this.installEmbedded(message);
	}

	/**
	 * The room is joined now: visible and live. A thread read before without
	 * joining it has missed what happened since its last load, which the next
	 * `loadRoom` catches up on.
	 */
	private markJoined(room: RoomState): void {
		if (room.kind === 'viewed') {
			if (room.loadCheckpoint !== undefined) room.resumed = true;
			this.forgetListings(this.store.room(room.id)?.parent_room_id);
		}
		room.kind = 'joined';
		if (!this.isThread(room.id)) this.activeRoomId ??= room.id;
	}

	/** Starts or resumes a top-level room's automatic recovery when its head is past the checkpoint. */
	private recoverIfBehind(room: RoomState, fresh: boolean): void {
		const head = room.latestLogId;
		if (!this.recoversAutomatically(room) || room.recovery || head === undefined) return;
		const rebuild = fresh || Boolean(room.recoveryError) || room.checkpoint === undefined;
		if (rebuild || compareLogIds(head, room.checkpoint!) > 0) this.startRecovery(room, head, rebuild);
	}

	/** An embedded `reply_to` or `intro_message` snapshot: its author is a recorded object. */
	private installEmbedded(message: MessageRecord): void {
		this.observeLogId(message.log_id);
		this.noteRecorded(message.from, message.log_id);
		this.acceptLiveMessage(message, false);
	}

	/**
	 * A room left, removed, no longer visible, or deleted (§4.3.3). A room
	 * kept from the last connection and not joined on this one goes back to
	 * being kept, so joining it later resumes where it stopped.
	 */
	private hideRoom(roomId: string): void {
		const room = this.rooms.get(roomId);
		if (!room) return;
		this.discardRoom(room, 'Room left');
		this.rooms.delete(roomId);
		if (room.kind === 'pending') this.retainedRooms.set(roomId, room);
		this.forgetListings(this.store.room(roomId)?.parent_room_id);
		if (this.activeRoomId === roomId) this.activeRoomId = this.defaultRoomId();
	}

	/** A record of a room not joined, such as a new thread in a joined room: listings that show it take it. */
	private noteUnjoinedRoom(record: RoomRecord, delivery: RoomDelivery): void {
		const listing = (members: Identity[]): RoomListing => ({
			id: record.room_id,
			title: roomTitle(record.room_id, record),
			record,
			...(record.parent_room_id !== undefined ? { parentRoomId: record.parent_room_id } : {}),
			...(delivery.latest_log_id !== undefined ? { latestLogId: delivery.latest_log_id } : {}),
			...(Object.hasOwn(delivery, 'history_log_id') ? { historyLogId: delivery.history_log_id } : {}),
			members,
			joined: false
		});
		const replace = (listings: RoomListing[]) => listings.map((known) => known.id === record.room_id ? listing(known.members) : known);
		if (this.directory) this.directory = replace(this.directory);
		const parent = record.parent_room_id;
		if (parent === undefined) return;
		const threads = this.threadDirectory.get(parent);
		if (threads?.some((known) => known.id === record.room_id)) this.threadDirectory.set(parent, replace(threads));
		else if (threads || this.rooms.has(parent)) this.threadDirectory.set(parent, [...(threads ?? []), listing([])]);
		this.forgetListings(parent);
	}

	/**
	 * Without cap `rooms` there is one default room (§3.4): shown under
	 * `DEFAULT_ROOM_ID` and posted to without `room_id` until a message reveals
	 * its `room_id`.
	 */
	private showDefaultRoom(): void {
		const roomId = this.defaultRoom ?? DEFAULT_ROOM_ID;
		if (!this.rooms.has(roomId)) this.rooms.set(roomId, this.adoptRetainedRoom(roomId) ?? newRoomState(roomId));
		this.activeRoomId ??= roomId;
	}

	/** The default room's `room_id` is known: it takes the place of `DEFAULT_ROOM_ID`. */
	private learnDefaultRoom(roomId: string): void {
		if (this.hasCap('rooms') || roomId === DEFAULT_ROOM_ID) return;
		this.defaultRoom = roomId;
		if (!this.rooms.has(DEFAULT_ROOM_ID)) return;
		this.rooms.delete(DEFAULT_ROOM_ID);
		const notices = this.notices.get(DEFAULT_ROOM_ID);
		if (notices) {
			this.notices.delete(DEFAULT_ROOM_ID);
			this.notices.set(roomId, [...(this.notices.get(roomId) ?? []), ...notices.map((notice) => ({ ...notice, room_id: roomId }))]);
		}
		this.showMessageRoom(roomId);
		if (this.activeRoomId === DEFAULT_ROOM_ID) this.activeRoomId = roomId;
	}

	/**
	 * A room a message or notice arrived in. Without cap `rooms` every such
	 * room is shown, titled by its `room_id` (§3.4), and the first one takes the
	 * default room's place.
	 */
	private showMessageRoom(roomId: string): void {
		if (this.rooms.has(roomId) || !this.authenticated || this.hasCap('rooms')) return;
		if (this.rooms.has(DEFAULT_ROOM_ID) && ![...this.rooms.keys()].some((id) => id !== DEFAULT_ROOM_ID)) {
			this.learnDefaultRoom(roomId);
			return;
		}
		const existing = this.adoptRetainedRoom(roomId);
		const room = existing ?? newRoomState(roomId);
		this.rooms.set(roomId, room);
		this.activeRoomId ??= roomId;
	}

	/** Where a notice without `room_id` shows: the default room, else the room in view; undefined while there is none. */
	private noticeRoom(): string | undefined {
		if (this.defaultRoom !== undefined) return this.defaultRoom;
		if (!this.hasCap('rooms')) return DEFAULT_ROOM_ID;
		return this.activeRoomId ?? this.defaultRoomId();
	}

	/**
	 * Shows a transient notice in a room for this session (§3.5). It sits
	 * after everything received so far: any message created later has a
	 * greater `message_id`, and history loaded later sorts above it. Without a
	 * room, it waits for the first one.
	 */
	private addNotice(roomId: string | undefined, from: Identity, body?: MessageBody): void {
		if (roomId === undefined) {
			this.orphanNotices.push({ from, ...(body ? { body } : {}) });
			return;
		}
		this.showMessageRoom(roomId);
		const room = this.rooms.get(roomId);
		const after = maxDefined(this.greatestLogId, room?.latestLogId) ?? String(Date.now());
		const notice: Notice = { key: `notice:${++this.noticeCount}`, room_id: roomId, from, ...(body ? { body } : {}), after, at: Date.now() };
		this.notices.set(roomId, [...(this.notices.get(roomId) ?? []), notice]);
	}

	/** Notices that waited for a room go to the first one there is. */
	private placeOrphanNotices(): void {
		if (!this.orphanNotices.length) return;
		const roomId = this.noticeRoom();
		if (roomId === undefined) return;
		for (const { from, body } of this.orphanNotices.splice(0)) this.addNotice(roomId, from, body);
	}

	private handleSnapshot(params: JsonObject | undefined): void {
		const decoded = decodeMessage(params);
		if (!decoded) {
			// A message without `message_id` is a transient notice, never a snapshot (§3.5).
			const notice = decodeNotice(params);
			if (!notice) return;
			this.addNotice(notice.room_id ?? this.noticeRoom(), notice.from, notice.body);
			this.emit();
			return;
		}
		const record = decoded.record;
		this.observeLogId(record.log_id);
		for (const embedded of decoded.embedded) this.observeLogId(embedded.log_id);
		this.noteRecorded(record.from, record.log_id);
		for (const embedded of decoded.embedded) this.noteRecorded(embedded.from, embedded.log_id);
		if (this.defaultPosts.delete(record.message_id)) this.learnDefaultRoom(record.room_id);
		this.showMessageRoom(record.room_id);
		// A room shown for its messages has no record to say where its log
		// ends: its first message on a connection does, and it recovers up to
		// that (§4.1), buffering the message meanwhile.
		const room = this.rooms.get(record.room_id);
		if (room && !this.store.room(room.id) && room.recoveredOn !== this.connectionId && isLogId(record.log_id)) {
			room.recoveredOn = this.connectionId;
			if (room.floor === undefined || compareLogIds(record.log_id, room.floor) >= 0) this.observeHead(room, record.log_id);
			this.recoverIfBehind(room, false);
		}
		this.acceptLiveMessage(record, true);
		for (const embedded of decoded.embedded) this.acceptLiveMessage(embedded, false);
		// A new message from a user ends their typing indicator in that room (§4.4).
		if (record.log_id === record.message_id) {
			this.removeTyping(record.room_id, record.from.user_id);
			// A server-wide notice reaches every user, joined to its room or not
			// (Appendix A.1): one for a room that is not shown shows where you are.
			if (record.from.user_id === '@server' && room?.kind !== 'joined' && this.hasCap('rooms')) {
				this.addNotice(this.noticeRoom(), record.from, record.body);
			}
		}
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
		this.observeLogId(sets[0].log_id);
		for (const set of sets) {
			this.noteRecorded(set.from, set.log_id);
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

	private startRecovery(room: RoomState, head: string | undefined, rebuild: boolean, preserveBuffer = false): void {
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
			...(head !== undefined ? { head } : {}),
			nextAfter,
			buffer: retained,
			bufferBytes: retained.reduce((bytes, live) => bytes + recordBytes(live.record), 0),
			generation
		};
		room.recoveryError = undefined;
		if (head !== undefined && compareLogIds(nextAfter, head) > 0) {
			this.finishRecovery(room);
			return;
		}
		this.requestHistoryPage(room, generation);
	}

	private requestHistoryPage(room: RoomState, generation: number): void {
		const recovery = room.recovery;
		if (!recovery || recovery.generation !== generation) return;
		// A room kept from the last connection resumes right behind `auth` (§3.2).
		const pipelined = !this.authenticated && this.authRequested;
		if (!this.authenticated && !pipelined) return;
		const request = this.enqueueRequest('history', historyParams(room.id, recovery.nextAfter, recovery.head), {
			visible: false, allowBeforeAuth: pipelined
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
		// A recovery started without a head takes the first page's (§4.1).
		recovery.head ??= result.latest_log_id;
		this.observeHistoryResponse(room, result);
		if (room.recovery !== recovery || recovery.generation !== generation) return;
		this.applyPage(room, result);
		const lastId = isLogId(result.last_log_id) ? result.last_log_id : undefined;
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

	/**
	 * Install a page's records, skipping message and reaction records below
	 * the room's bound. Memberships keep the room's member list current; a
	 * listing's members already cover the ones at or below its head.
	 */
	private applyPage(room: RoomState, result: JsonObject): void {
		const records: DecodedRecords = decodeHistoryRecords(result);
		for (const record of [...records.rooms, ...records.messages, ...records.embedded, ...records.reactions, ...records.memberships]) this.observeLogId(record.log_id);
		for (const record of [...records.messages, ...records.embedded, ...records.reactions]) this.noteRecorded(record.from, record.log_id);
		for (const record of records.memberships) this.noteRecorded(record.user, record.log_id);
		const retained = (logId: string) => room.floor === undefined || compareLogIds(logId, room.floor) >= 0;
		for (const record of records.rooms) this.installRoom(record);
		for (const record of records.messages) if (retained(record.log_id)) this.installMessage(record);
		for (const record of records.reactions) if (retained(record.log_id)) this.store.putReaction(record);
		for (const record of records.memberships) this.store.putMembership(record);
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
			this.startRecovery(room, recovery.head ?? room.latestLogId, true, true);
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

	/**
	 * After a lost connection: hide every room until the next connection
	 * lists it as joined, but keep its records, floor and checkpoint so it resumes
	 * from there (§4.1 recovery from `C + 1`). Everything else scoped to
	 * the connection is forgotten as in `discardProtocolView`.
	 */
	private suspendProtocolView(reason: string): void {
		for (const room of this.rooms.values()) {
			this.discardRoom(room, reason);
			this.retainedRooms.set(room.id, room);
		}
		this.rooms.clear();
		// The kept joined rooms stand for this identity's whole set only if its listing arrived.
		this.keptUserId = this.joinedComplete ? this.you?.user_id : undefined;
		this.forgetConnectionState();
	}

	/** A room kept from a lost connection, now joined (or shown) again. */
	private adoptRetainedRoom(roomId: string): RoomState | undefined {
		const room = this.retainedRooms.get(roomId);
		if (!room) return undefined;
		this.retainedRooms.delete(roomId);
		// Anything in flight was cancelled with the old connection.
		room.loading = false;
		room.loadingOlder = false;
		room.recoveryError = undefined;
		// A thread's checkpoint predates the gap; the next load catches up from it.
		if (room.loadCheckpoint !== undefined) room.resumed = true;
		// Reaction summaries depend on the viewer, who may be a new guest.
		room.dirty = true;
		return room;
	}

	/** Forget every connection-scoped protocol record; the next connection lists rooms afresh. */
	private discardProtocolView(reason: string): void {
		for (const room of this.rooms.values()) this.discardRoom(room, reason);
		this.rooms.clear();
		this.retainedRooms.clear();
		this.store.clear();
		this.store.takeTouched();
		this.users.clear();
		this.recordedUsers.clear();
		this.userAliases.clear();
		this.greatestLogId = undefined;
		this.notices.clear();
		this.orphanNotices = [];
		this.defaultRoom = undefined;
		this.defaultPosts.clear();
		this.joinedComplete = false;
		this.keptUserId = undefined;
		this.forgetConnectionState();
	}

	private forgetConnectionState(): void {
		this.reactionIntents.clear();
		this.pendingMessageSaves.clear();
		this.pendingRoomSaves.clear();
		this.activeRoomId = undefined;
		this.server = undefined;
		this.you = undefined;
		this.reads.clear();
		this.listings.clear();
		this.joinedListing = undefined;
		this.directory = undefined;
		this.threadDirectory.clear();
		this.awaySent = false;
	}

	/** The room to show when none is chosen: the first joined top-level room, else the first joined one. */
	private defaultRoomId(): string | undefined {
		const joined = this.orderedRooms().filter((room) => room.kind === 'joined');
		return (joined.find((room) => !this.isThread(room.id)) ?? joined[0])?.id;
	}

	/**
	 * An `activity` broadcast (§4.4): present fields change the user's
	 * transient state, absent ones leave it. `typing` seconds show or refresh
	 * the indicator, `0` removes it. `read_message_id` moves that user's read
	 * cursor forward; yours places the New divider.
	 */
	private handleActivity(params: JsonObject | undefined): void {
		if (!params || typeof params.room_id !== 'string' || !isIdentity(params.from)) return;
		const room = params.room_id;
		// The sender is neither a current nor a recorded object (§3.3): it renders through the kept one.
		const from = cloneJson(params.from);
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
		if (rpcError) request.reject(this.errorFromRpc(isJsonObject(rpcError) ? rpcError : { code: -32603, message: 'Invalid error' }, request.method === 'auth'));
		else request.resolve(result);
		this.emit();
	}

	/**
	 * `connection`: a refused `auth`, whose `retry_after` holds back reconnecting.
	 * Any other request's `retry_after` is that request's limit (a throttled
	 * listing or history page) and stays on its error for the caller.
	 */
	private errorFromRpc(rpcError: RpcError, connection = false): Error {
		const retryAfter = retryAfterMilliseconds(rpcError);
		if (retryAfter !== undefined && connection) {
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
			if (this.waitForPresence()) return;
			this.connectNow();
		}, delay);
	}

	/**
	 * Connecting waits while the page is hidden or the browser is offline: a
	 * background tab needs no socket until it is looked at, and every new
	 * connection costs the server a session and its history. An open socket is
	 * kept. Returns whether it is waiting; it connects once both clear.
	 */
	private waitForPresence(): boolean {
		if (!absent()) return false;
		if (this.presenceWaiter) return true;
		const resume = (): void => {
			if (absent()) return;
			this.stopWaitingForPresence();
			if (this.running && !this.socket && !this.reconnectTimer) this.connectNow();
		};
		this.presenceWaiter = resume;
		globalThis.document?.addEventListener('visibilitychange', resume);
		globalThis.addEventListener?.('online', resume);
		return true;
	}

	private stopWaitingForPresence(): void {
		const resume = this.presenceWaiter;
		if (!resume) return;
		this.presenceWaiter = undefined;
		globalThis.document?.removeEventListener('visibilitychange', resume);
		globalThis.removeEventListener?.('online', resume);
	}

	private clearStableTimer(): void {
		if (this.stableTimer) clearTimeout(this.stableTimer);
		this.stableTimer = undefined;
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
		this.placeOrphanNotices();
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}
}

/**
 * How to render a user (§3.3): field by field, the kept object for its
 * `user_id` (following a retired ID to the identity that replaced it), else
 * the recorded object the frame carries (`from`, a membership's `user`), and
 * the display name falls back to the `user_id` last. Returns the kept object
 * itself when it has every field the recorded one has.
 */
export function userIn(snapshot: Pick<ClientSnapshot, 'users' | 'userAliases'>, recorded: Identity): Identity {
	let id = recorded.user_id;
	for (let hops = 0; hops < 8 && snapshot.userAliases[id] !== undefined; hops += 1) id = snapshot.userAliases[id];
	const kept = snapshot.users[id] ?? snapshot.users[recorded.user_id];
	if (!kept) return recorded;
	const missing = Object.keys(recorded).filter((key) => key !== 'user_id' && !Object.hasOwn(kept, key) && recorded[key] !== undefined && recorded[key] !== null);
	if (!missing.length) return kept;
	const merged: JsonObject = Object.create(null);
	for (const key of missing) merged[key] = recorded[key];
	return Object.assign(merged, kept) as Identity;
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

/** Rooms without a parent, in listing order. */
export function topLevelRooms(rooms: readonly RoomSnapshot[]): RoomSnapshot[] {
	return rooms.filter((room) => room.parentRoomId === undefined);
}

/** Direct children (threads) of a room, in listing order. */
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

function decrement(id: string): string {
	return (BigInt(id) - 1n).toString();
}

function maxDefined(a: string | undefined, b: string | undefined): string | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return compareLogIds(a, b) >= 0 ? a : b;
}

/** A message's client fields (§4.2), as a save would submit them. */
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

/** Shared by rooms without notices, so their snapshots compare equal. */
const NO_NOTICES: readonly Notice[] = Object.freeze([]);

/** A room's display title: its record's `title`, else its `room_id` (§3.4). */
function roomTitle(roomId: string, record: RoomRecord | undefined): string {
	if (typeof record?.title === 'string' && record.title) return record.title;
	if (roomId === DEFAULT_ROOM_ID) return 'Default room';
	return roomId;
}

/**
 * One user object merged into the kept one (§3.3): a present field replaces
 * the kept value, an empty value (`""`, `{}`) removes it, and a missing (or
 * `null`) field leaves it. Returns `current` itself when nothing changes.
 */
export function mergeIdentity(current: Identity | undefined, incoming: Identity): Identity {
	const next: JsonObject = Object.create(null);
	if (current) Object.assign(next, current);
	next.user_id = incoming.user_id;
	let changed = !current;
	for (const key of Object.keys(incoming)) {
		if (key === 'user_id') continue;
		const value = incoming[key];
		if (value === undefined || value === null) continue;
		if (value === '' || (isJsonObject(value) && Object.keys(value).length === 0)) {
			if (Object.hasOwn(next, key)) {
				delete next[key];
				changed = true;
			}
			continue;
		}
		if (!Object.hasOwn(next, key) || canonicalJson(next[key]) !== canonicalJson(value)) {
			next[key] = cloneJson(value);
			changed = true;
		}
	}
	return changed ? next as Identity : current!;
}

function sameEmojiSet(left: readonly string[], right: readonly string[]): boolean {
	const a = new Set(left), b = new Set(right);
	return a.size === b.size && [...a].every((emoji) => b.has(emoji));
}

function isEmbedded(live: LiveRecord): boolean {
	return live.kind === 'message' && live.embedded === true;
}

/** A forward page; without `before` (a recovery that has no head yet) it runs to the end of the log (§4.1). */
function historyParams(roomId: string, after: string | undefined, before: string | undefined): JsonObject {
	return { room_id: roomId, after: after ?? FIRST_LOG_ID, ...(before !== undefined ? { before } : {}), limit: HISTORY_PAGE_SIZE };
}

/** Record arrays that a history page may omit when empty (§4.1). */
const HISTORY_ARRAYS = ['rooms', 'messages', 'reactions', 'membership'];

function validHistoryMetadata(result: JsonObject): result is ValidHistoryResponse {
	if (HISTORY_ARRAYS.some((key) => result[key] !== undefined && !Array.isArray(result[key]))) return false;
	if (typeof result.more !== 'boolean' || !isLogId(result.latest_log_id)) return false;
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
/** Whether the page is hidden or the browser reports no network; false outside a browser. */
function absent(): boolean {
	return globalThis.document?.visibilityState === 'hidden' || globalThis.navigator?.onLine === false;
}

export function reconnectDelay(attempt: number, random = 0.5, retryAfterMs?: number): number {
	const boundedAttempt = Math.max(1, Math.floor(attempt));
	const base = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(7, boundedAttempt - 1));
	const jitter = 0.8 + Math.min(1, Math.max(0, random)) * 0.4;
	return Math.max(retryAfterMs ?? 0, Math.round(base * jitter));
}

// Re-exported for callers that build saves or projections themselves.
export { cloneJson };
