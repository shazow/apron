import { requestPasskey } from './webauthn';
import {
	applyTransitions,
	pruneTimelineBefore,
	TimelineReplay,
	compareLogIds,
	createTimeline,
	timelineEvents,
	type TimelineState
} from './reducer';
import {
	isJsonObject,
	isLogId,
	isString,
	toTransition,
	type MessageRecord,
	type JsonObject,
	type RpcError,
	type ServerParams,
	type Identity,
	type ThreadAnnouncement,
	type Transition,
	type WireFrame
} from './types';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface RoomSnapshot {
	id: string;
	name: string;
	topic?: string;
	latestId?: string;
	historyFloor?: string;
	timeline: TimelineState;
	threads: ThreadAnnouncement[];
	recovering: boolean;
	recoveryError?: string;
}

export interface PendingOperation {
	id: string;
	method: string;
	room?: string;
	createdAt: number;
}

export interface TypingSnapshot {
	room: string;
	from: Identity;
	active: boolean;
}

export interface ClientSnapshot {
	status: ConnectionStatus;
	authBusy?: boolean;
	passkeySession?: boolean;
	error?: string;
	server?: ServerParams;
	you?: Identity;
	rooms: RoomSnapshot[];
	activeRoom?: string;
	pending: PendingOperation[];
	typing: TypingSnapshot[];
	showReconnectDivider: boolean;
	/** Server supplied retry delay for the most recent temporary limit. */
	retryAfterMs?: number;
}

export interface OperationHandle<T extends JsonObject = JsonObject> {
	id: string;
	promise: Promise<T>;
}

export interface ChatClientOptions {
	serverUrl: string;
	displayName?: string;
	onChange?: (snapshot: ClientSnapshot) => void;
}

interface RoomState extends RoomSnapshot {
	/** Internal monotonic floor. Older servers are treated as floor "1". */
	floor: string;
	/** Highest room-log coverage established by recovery. */
	checkpoint: string;
	recovery?: RecoveryState;
	threadCheckpoints: Map<string, string>;
	threadGenerations: Map<string, number>;
}

interface RecoveryState {
	head: string;
	/** Next unprocessed lower bound (`C + 1`), with `0` as the empty-log sentinel. */
	nextAfter: string;
	buffer: Transition[];
	bufferBytes: number;
	replay: TimelineReplay;
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
	active: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 20_000;
const HISTORY_PAGE_SIZE = 200;
const MAX_RECONNECT_DELAY_MS = 10_000;
const MAX_HISTORY_BUFFER_ENTRIES = 1_000;
const MAX_HISTORY_BUFFER_BYTES = 1_048_576;
const DEFAULT_HISTORY_FLOOR = '1';
const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;

/** A browser-only protocol session; instantiate one per mounted UI. */
export class ChatClient {
	private readonly listeners = new Set<(snapshot: ClientSnapshot) => void>();
	private readonly rooms = new Map<string, RoomState>();
	private readonly requests = new Map<string, PendingRequest>();
	private readonly typing = new Map<string, TypingState>();
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

	constructor(private serverUrl: string, displayName = '') {
		this.displayName = displayName.trim();
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
		this.resetSession('Server URL changed; pending requests were cancelled');
		if (this.running) this.restart();
	}

	/**
	 * Sets the handle sent with the protocol `nick` request. When authenticated
	 * the request goes out at once and its handle is returned so the caller can
	 * show what the server actually kept.
	 */
	setDisplayName(displayName: string): OperationHandle | undefined {
		this.displayName = displayName.trim();
		if (this.authenticated && this.displayName) {
			return this.sendNick();
		}
		return undefined;
	}

	private sendNick(): OperationHandle {
		const request = this.enqueueRequest('nick', { name: this.displayName }, {
			visible: false,
			allowBeforeAuth: false
		});
		request.promise
			.then((result) => {
				if (isJsonObject(result.you) && typeof result.you.user_id === 'string') this.you = result.you as Identity;
				this.emit();
			})
			.catch(() => {
				// Nick is advisory; a server may reject it without affecting the session.
			});
		return request;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.showReconnectDivider = this.reconnectAttempt > 0;
		this.connectNow();
	}

	stop(): void {
		this.cancelPasskey();
		this.running = false;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		const socket = this.socket;
		this.socket = undefined;
		this.authenticated = false;
		this.authRequested = false;
		for (const typing of this.typing.values()) {
			if (typing.timer) clearTimeout(typing.timer);
		}
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
		this.cancelPasskey();
		const socket = this.socket;
		this.socket = undefined;
		this.authenticated = false;
		this.authRequested = false;
		this.clearTransientRequests();
		this.rooms.clear();
		this.activeRoomId = undefined;
		this.server = undefined;
		this.you = undefined;
		if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, 'reconnecting');
		this.status = 'reconnecting';
		this.scheduleReconnect(0);
		this.emit();
	}

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
		return {
			status: this.status,
			authBusy: Boolean(this.passkeyAbort),
			passkeySession: Boolean(this.registeredSession && this.authenticated),
			error: this.error,
			server: this.server,
			you: this.you,
			rooms: [...this.rooms.values()].map((room) => ({
				id: room.id,
				name: room.name,
				...(room.topic !== undefined ? { topic: room.topic } : {}),
				...(room.latestId !== undefined ? { latestId: room.latestId } : {}),
				...(room.historyFloor !== undefined ? { historyFloor: room.historyFloor } : {}),
				timeline: room.timeline,
				threads: room.threads,
				recovering: Boolean(room.recovery),
				...(room.recoveryError ? { recoveryError: room.recoveryError } : {})
			})),
			activeRoom: this.activeRoomId,
			pending: [...this.requests.values()]
				.filter((request) => request.visible)
				.map(({ id, method, params, createdAt }) => ({
					id,
					method,
					room: typeof params.room_id === 'string' ? params.room_id : undefined,
					createdAt
				})),
			typing: [...this.typing.values()]
				.filter((entry) => entry.active)
				.map(({ room, from, active }) => ({ room, from, active })),
			showReconnectDivider: this.showReconnectDivider,
			retryAfterMs: this.retryAfterRemaining()
		};
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
			const extension = this.usesWebAuthnDemoExtension();
			const begin = extension
				? { scheme: 'webauthn', action, step: 'begin' }
				: { scheme: 'webauthn', action: `${action}_begin` };
			const options = await this.passkeyRequest(begin);
			const credential = await requestPasskey(action, options, controller.signal);
			if (controller.signal.aborted || connection !== this.connectionId) throw new Error('Connection changed; try again');
			const challengeId = typeof options.challenge_id === 'string' ? options.challenge_id : undefined;
			if (extension && !challengeId) throw new Error('Passkey challenge was missing; try again');
			const finish = extension
				? { scheme: 'webauthn', action, step: 'finish', ...(challengeId ? { challenge_id: challengeId } : {}), credential }
				: { scheme: 'webauthn', action: `${action}_finish`, credential };
			const result = await this.passkeyRequest(finish);
			if (controller.signal.aborted || connection !== this.connectionId) throw new Error('Connection changed; try again');
			this.cancelPasskey();
			this.registeredSession = true;
			this.passkeyRequired = true;
			this.handleAuth(result);
		} finally {
			if (this.passkeyAbort === controller) this.cancelPasskey();
			this.emit();
		}
	}

	async signOut(): Promise<void> {
		if (this.passkeyAbort || this.requests.size) throw new Error('Wait for pending requests to finish, then try again');
		const controller = new AbortController();
		this.passkeyAbort = controller;
		this.emit();
		try {
			// The demo extension defines only begin/finish ceremonies. Signing out
			// therefore drops this client session and reconnects as a fresh guest;
			// the Go example still supports its explicit logout action.
			if (!this.usesWebAuthnDemoExtension()) await this.passkeyRequest({ scheme: 'webauthn', action: 'logout' });
			if (controller.signal.aborted) throw new Error('Connection changed; try again');
			this.sessionToken = undefined;
			this.passkeyRequired = false;
			this.registeredSession = false;
			this.resetSession('Signed out');
			this.restart();
		} finally {
			if (this.passkeyAbort === controller) this.cancelPasskey();
			this.emit();
		}
	}

	private passkeyRequest(params: JsonObject): Promise<JsonObject> {
		return this.enqueueRequest('auth', params, {
			visible: false, allowBeforeAuth: true
		}).promise;
	}

	private usesWebAuthnDemoExtension(): boolean {
		return this.server?.extensions?.includes('webauthn.demo.v1') === true;
	}

	private cancelPasskey(): void {
		this.passkeyAbort?.abort(new DOMException('Connection changed; try again', 'AbortError'));
		this.passkeyAbort = undefined;
	}

	sendMessage(room: string, text: string, format: 'plain' | 'markdown' = 'markdown', thread?: string, replyMessageId?: string): OperationHandle {
		return this.saveMessage({
			room_id: room, body: { text, format },
			...(thread ? { thread_id: thread } : {}),
			...(replyMessageId !== undefined ? { reply_message_id: replyMessageId } : {})
		});
	}

	setMessageReply(room: string, messageId: string, replyMessageId: string | null): OperationHandle {
		const params = this.editableMessage(room, messageId);
		if (replyMessageId === null) delete params.reply_message_id;
		else params.reply_message_id = replyMessageId;
		return this.saveMessage(params);
	}

	createThread(room: string, metadata: { title?: string; summary?: string; root_message_id?: string } = {}): OperationHandle {
		return this.enqueueRequest('thread', { room_id: room, ...metadata }, { visible: true, allowBeforeAuth: false });
	}

	updateThread(room: string, thread: string, metadata: { title?: string; summary?: string }): OperationHandle {
		return this.enqueueRequest('thread', { room_id: room, thread_id: thread, ...metadata }, { visible: true, allowBeforeAuth: false });
	}

	private editableMessage(room: string, messageId: string): JsonObject {
		const message = this.rooms.get(room)?.timeline.events[messageId];
		if (!message) throw new Error('Message has not been loaded');
		const { from: _from, ...editable } = message;
		return { ...editable, room_id: room };
	}

	private saveMessage(params: JsonObject): OperationHandle {
		return this.enqueueRequest('message', params, { visible: true, allowBeforeAuth: false });
	}

	setMessageThread(room: string, messageId: string, thread: string | null): OperationHandle {
		const params = this.editableMessage(room, messageId);
		if (thread === null) delete params.thread_id;
		else params.thread_id = thread;
		return this.saveMessage(params);
	}

	updateMessage(room: string, messageId: string, text: string, format?: 'plain' | 'markdown'): OperationHandle {
		const params = this.editableMessage(room, messageId);
		params.body = { ...(isJsonObject(params.body) ? params.body : {}), text, ...(format ? { format } : {}) };
		return this.saveMessage(params);
	}

	deleteMessage(room: string, messageId: string): OperationHandle {
		const params = this.editableMessage(room, messageId);
		params.deleted = true;
		delete params.body;
		return this.saveMessage(params);
	}

	sendTyping(room: string, active: boolean): void {
		if (!this.authenticated || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
		this.sendFrame({ method: 'typing', params: { room_id: room, active, timeout: 8 } });
	}

	/** Fetch a thread independently; its progress never advances room history coverage. */
	async loadThread(roomId: string, threadId: string): Promise<void> {
		const room = this.rooms.get(roomId);
		if (!room || !this.server?.caps?.includes('history')) return;
		const head = room.latestId;
		if (!head || head === '0') return;
		const generation = (room.threadGenerations.get(threadId) ?? 0) + 1;
		room.threadGenerations.set(threadId, generation);
		let checkpoint = room.threadCheckpoints.get(threadId) ?? '0';
		if (compareLogIds(increment(checkpoint), room.floor) < 0) checkpoint = decrement(room.floor);
		let after = nextRecoveryAfter(checkpoint, room.floor);
		while (compareLogIds(after, head) <= 0) {
			const result = await this.enqueueRequest('history', {
				room_id: roomId, thread_id: threadId, after, before: head, limit: HISTORY_PAGE_SIZE
			}, { visible: false, allowBeforeAuth: false }).promise;
			if (this.rooms.get(roomId) !== room || room.threadGenerations.get(threadId) !== generation) return;
			if (!Array.isArray(result.entries) || typeof result.more !== 'boolean') throw new Error('Invalid history response');
			this.observeHistoryFloor(room, result.history_floor);
			if (this.rooms.get(roomId) !== room || room.threadGenerations.get(threadId) !== generation) return;
			if (compareLogIds(nextRecoveryBoundary(after), room.floor) < 0) {
				checkpoint = decrement(room.floor);
				after = nextRecoveryAfter(checkpoint, room.floor);
				room.threadCheckpoints.set(threadId, checkpoint);
				continue;
			}
			const transitions = result.entries.map(toTransition).filter((entry): entry is Transition => Boolean(entry));
			// A filtered page has its own checkpoint, but while room recovery is
			// active its snapshots still join the bounded recovery stream so a room
			// replay cannot overwrite them when it finishes.
			this.acceptTransitions(roomId, transitions);
			if (!result.more) {
				room.threadCheckpoints.set(threadId, maxLogId(checkpoint, head));
				return;
			}
			if (!isLogId(result.last_id) || compareLogIds(result.last_id, after) < 0 || compareLogIds(result.last_id, head) >= 0) {
				throw new Error('Invalid history continuation');
			}
			after = increment(result.last_id);
			checkpoint = maxLogId(checkpoint, decrement(after));
			room.threadCheckpoints.set(threadId, checkpoint);
		}
	}

	private connectNow(): void {
		if (!this.running || this.socket) return;
		const id = ++this.connectionId;
		this.status = this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting';
		this.error = undefined;
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
			if (this.isCurrentSocket(id, socket)) this.error = 'WebSocket connection error';
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
			this.rooms.clear();
			this.activeRoomId = undefined;
			this.server = undefined;
			this.you = undefined;
			if (this.running) {
				this.status = 'reconnecting';
				this.scheduleReconnect();
			} else {
				this.status = 'offline';
			}
			this.emit();
		};
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
		if (frame.method === 'server') {
			this.handleServer(frame.params);
			return;
		}
		if (frame.method === 'room') {
			this.handleRoom(frame.params);
			return;
		}
		if (frame.method === 'thread') {
			this.handleThread(frame.params);
			return;
		}
		if (frame.method === 'message') {
			this.handleSnapshot(frame.params);
			return;
		}
		if (frame.method === 'typing') {
			this.handleTyping(frame.params);
			return;
		}
		if (typeof frame.id === 'string' && (frame.result || frame.error)) {
			this.handleResponse(frame.id, frame.result ?? {}, frame.error);
		}
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
			...(typeof params.upload === 'string' ? { upload: params.upload } : {}),
			...(Array.isArray(params.extensions) ? { extensions: params.extensions.filter(isString) } : {}),
			...(isJsonObject(params.demo) ? { demo: params.demo } : {})
		};
		if (this.authenticated || this.authRequested) {
			this.emit();
			return;
		}
		const resume = Boolean(this.sessionToken && auth.includes('webauthn'));
		if (!resume && this.passkeyRequired && this.usesWebAuthnDemoExtension() && auth.includes('webauthn')) {
			// The demo extension deliberately has no bearer-token resume action.
			// Re-run discoverable login after a transport reconnect so a registered
			// user does not get stranded on an unauthenticated empty room view.
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
		if (!resume && (this.passkeyRequired || !auth.includes('anonymous'))) {
			this.error = auth.includes('webauthn') ? 'Sign in with a passkey from your profile.' : 'No supported authentication scheme';
			this.emit();
			return;
		}
		this.authRequested = true;
		const socket = this.socket;
		const request = this.enqueueRequest('auth', {
			...(resume ? { scheme: 'webauthn', action: 'resume', token: this.sessionToken } : { scheme: 'anonymous' }),
			client: 'bottomless-web/0.1'
		}, { visible: false, allowBeforeAuth: true });
		request.promise.then((result) => {
			if (socket === this.socket) this.handleAuth(result);
		}).catch((cause: Error) => {
			if (socket !== this.socket) return;
			this.authRequested = false;
			// Never silently downgrade a passkey session to a different guest identity.
			if (resume) this.sessionToken = undefined;
			this.error = cause.message;
			this.emit();
		});
	}

	private handleAuth(result: JsonObject): void {
		const identity = result.you;
		if (!isJsonObject(identity) || typeof identity.user_id !== 'string') {
			this.error = 'Server authentication response did not include an identity';
			this.emit();
			return;
		}
		this.you = identity as Identity;
		if (typeof result.token === 'string') {
			this.sessionToken = result.token;
			this.passkeyRequired = true;
			this.registeredSession = true;
		}
		this.error = undefined;
		this.retryAfterUntil = 0;
		this.authenticated = true;
		this.authRequested = false;
		this.reconnectAttempt = 0;
		this.showReconnectDivider = this.showReconnectDivider || this.rooms.size > 0;
		if (this.displayName) this.sendNick();
		this.emit();
	}

	private handleRoom(params: JsonObject | undefined): void {
		if (!params || typeof params.room_id !== 'string') return;
		const roomId = params.room_id;
		if (params.removed === true) {
			this.rooms.delete(roomId);
			if (this.activeRoomId === roomId) this.activeRoomId = this.rooms.keys().next().value;
			this.emit();
			return;
		}

		const existing = this.rooms.get(roomId);
		const room: RoomState = existing ?? {
			id: roomId,
			name: roomId,
			timeline: createTimeline(roomId),
			threads: [],
			recovering: false,
			floor: DEFAULT_HISTORY_FLOOR,
			checkpoint: '0',
			threadCheckpoints: new Map(),
			threadGenerations: new Map()
		};
		const previousHead = room.latestId;
		room.name = typeof params.name === 'string' ? params.name : roomId;
		room.topic = typeof params.topic === 'string' ? params.topic : undefined;
		if (params.latest_id === '0' || isLogId(params.latest_id)) {
			if (!room.latestId || compareWireHead(params.latest_id, room.latestId) > 0 || !existing) room.latestId = params.latest_id;
		}
		// Install the advertised head before processing a floor advance so a
		// rebuild captures the newest fixed head when both change together.
		this.observeHistoryFloor(room, params.history_floor);
		this.rooms.set(roomId, room);
		this.activeRoomId ??= roomId;
		const advertisedHead = params.latest_id === '0' || isLogId(params.latest_id) ? params.latest_id : room.latestId;
		const headAdvanced = advertisedHead !== undefined && (!previousHead || compareWireHead(advertisedHead, previousHead) > 0);
		const needsRecovery = !existing || Boolean(room.recoveryError) || headAdvanced ||
			(advertisedHead !== undefined && compareWireHead(room.checkpoint, advertisedHead) < 0 && !room.recovery);
		if (needsRecovery && this.server?.caps?.includes('history') && advertisedHead !== undefined && !room.recovery) {
			this.startRecovery(room, advertisedHead, Boolean(room.recoveryError || !existing || room.checkpoint === '0'));
		}
		this.emit();
	}

	private handleThread(params: JsonObject | undefined): void {
		if (!params || typeof params.room_id !== 'string' || typeof params.thread_id !== 'string') return;
		const room = this.rooms.get(params.room_id);
		if (!room) return;
		const thread: ThreadAnnouncement = {
			room_id: params.room_id, thread_id: params.thread_id,
			...(typeof params.title === 'string' ? { title: params.title } : {}),
			...(typeof params.summary === 'string' ? { summary: params.summary } : {}),
			...(isLogId(params.root_message_id) ? { root_message_id: params.root_message_id } : {})
		};
		room.threads = [...room.threads.filter((entry) => entry.thread_id !== params.thread_id), thread];
		this.emit();
	}

	private startRecovery(room: RoomState, head: string, reset = true): void {
		this.retireRecoveryRequest(room);
		const generation = (room.recovery?.generation ?? 0) + 1;
		const floor = room.floor;
		let nextAfter = reset ? nextRecoveryAfter(decrement(floor), floor) : nextRecoveryAfter(room.checkpoint, floor);
		const base = reset ? createTimeline(room.id) : pruneTimelineBefore(room.timeline, floor);
		if (reset) room.timeline = base;
		room.recovery = {
			head,
			nextAfter,
			buffer: [],
			bufferBytes: 0,
			replay: new TimelineReplay(base),
			generation
		};
		room.recovery.replay.pruneBefore(floor);
		room.recoveryError = undefined;
		if (head === '0' || compareLogIds(nextAfter, head) > 0) {
			this.finishRecovery(room);
			return;
		}
		this.requestHistoryPage(room, generation);
	}

	private requestHistoryPage(room: RoomState, generation: number): void {
		const recovery = room.recovery;
		if (!recovery || recovery.generation !== generation || !this.authenticated) return;
		const request = this.enqueueRequest('history', {
			room_id: room.id,
			after: recovery.nextAfter,
			before: recovery.head,
			limit: HISTORY_PAGE_SIZE
		}, { visible: false, allowBeforeAuth: false });
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
		this.observeHistoryFloor(room, result.history_floor);
		if (room.recovery !== recovery || recovery.generation !== generation) return;
		if (!Array.isArray(result.entries) || typeof result.more !== 'boolean') {
			this.abortRecovery(room, 'Invalid history response');
			return;
		}
		const transitions = result.entries
			.map(toTransition)
			.filter((entry): entry is Transition => Boolean(entry))
			.filter(({ log_id }) => compareLogIds(log_id, room.floor) >= 0 && compareLogIds(log_id, recovery.head) <= 0);
		recovery.replay.apply(transitions);
		const more = result.more;
		const lastId = typeof result.last_id === 'string' && isLogId(result.last_id) ? result.last_id : undefined;
		if (more) {
			if (!lastId || compareLogIds(lastId, recovery.nextAfter) < 0 || compareLogIds(lastId, recovery.head) >= 0) {
				this.abortRecovery(room, 'History pagination did not provide a valid continuation');
				return;
			}
			recovery.nextAfter = increment(lastId);
			recovery.requestId = undefined;
			this.requestHistoryPage(room, generation);
			this.emit();
			return;
		}
		if (lastId && compareLogIds(lastId, recovery.nextAfter) >= 0) recovery.nextAfter = increment(lastId);
		this.finishRecovery(room);
		this.emit();
	}

	private finishRecovery(room: RoomState): void {
		const recovery = room.recovery;
		if (!recovery) return;
		const buffered = recovery.buffer
			.filter(({ log_id }) => compareLogIds(log_id, room.floor) >= 0)
			.sort((a, b) => compareLogIds(transitionId(a), transitionId(b)));
		recovery.replay.apply(buffered);
		recovery.replay.pruneBefore(room.floor);
		room.timeline = recovery.replay.finish();
		room.checkpoint = maxLogId(room.checkpoint, maxLogId(decrement(recovery.nextAfter), recovery.head));
		room.recovery = undefined;
		this.showReconnectDivider = [...this.rooms.values()].every((entry) => !entry.recovery);
	}

	private handleSnapshot(params: JsonObject | undefined): void {
		if (!params || typeof params.room_id !== 'string') return;
		const transition = toTransition(params);
		if (transition) this.acceptTransitions(params.room_id, [transition]);
	}

	private acceptTransitions(roomId: string, transitions: Transition[], bufferDuringRecovery = true): void {
		const room = this.rooms.get(roomId);
		if (!room) return;
		const retained = transitions.filter(({ log_id }) => compareLogIds(log_id, room.floor) >= 0);
		for (const { log_id } of retained) {
			if (!room.latestId || compareLogIds(log_id, room.latestId) > 0) room.latestId = log_id;
		}
		if (room.recovery && bufferDuringRecovery) {
			for (const transition of retained) {
				const bytes = transitionBytes(transition);
				if (!recoveryBufferFits(room.recovery.buffer.length, room.recovery.bufferBytes, transition)) {
					this.restartRecoveryAfterOverflow(room);
					return;
				}
				room.recovery.buffer.push(transition);
				room.recovery.bufferBytes += bytes;
			}
		} else {
			room.timeline = applyTransitions(room.timeline, retained);
		}
		this.emit();
	}

	/** Apply an advertised floor monotonically and invalidate only unavailable snapshots. */
	private observeHistoryFloor(room: RoomState, advertised: unknown): void {
		if (!isLogId(advertised)) return;
		if (room.historyFloor === undefined) room.historyFloor = advertised;
		if (compareLogIds(advertised, room.floor) <= 0) return;
		room.floor = advertised;
		room.historyFloor = advertised;
		room.timeline = pruneTimelineBefore(room.timeline, advertised);
		for (const [thread, checkpoint] of room.threadCheckpoints) {
			if (compareLogIds(increment(checkpoint), advertised) < 0) room.threadCheckpoints.delete(thread);
		}
		const recovery = room.recovery;
		if (!recovery) {
			if (compareLogIds(increment(room.checkpoint), advertised) < 0 && this.server?.caps?.includes('history') && room.latestId && room.latestId !== '0') {
				this.startRecovery(room, room.latestId, true);
			}
			this.emit();
			return;
		}
		recovery.replay.pruneBefore(advertised);
		const retained: Transition[] = [];
		recovery.bufferBytes = 0;
		for (const transition of recovery.buffer) {
			if (compareLogIds(transition.log_id, advertised) < 0) continue;
			retained.push(transition);
			recovery.bufferBytes += transitionBytes(transition);
		}
		recovery.buffer = retained;
		// `nextAfter` is C + 1. Equality is the safe exact-boundary case; only a
		// strictly larger floor means a retained gap was discarded underneath us.
		if (compareLogIds(advertised, nextRecoveryBoundary(recovery.nextAfter)) > 0) {
			this.startRecovery(room, room.latestId && compareWireHead(room.latestId, recovery.head) > 0 ? room.latestId : recovery.head, true);
		}
		this.emit();
	}

	private restartRecoveryAfterOverflow(room: RoomState): void {
		const head = room.latestId && room.latestId !== '0' ? room.latestId : room.recovery?.head ?? '0';
		this.startRecovery(room, head, true);
		this.error = 'History is arriving faster than the client can recover; reconnecting.';
		this.scheduleReconnect();
		if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.close(1008, 'history recovery overflow');
	}

	private abortRecovery(room: RoomState, message: string): void {
		const recovery = room.recovery;
		if (!recovery) return;
		this.retireRecoveryRequest(room);
		room.recoveryError = message;
		room.timeline = pruneTimelineBefore(recovery.replay.finish(), room.floor);
		room.recovery = undefined;
		this.emit();
	}

	private retireRecoveryRequest(room: RoomState): void {
		const id = room.recovery?.requestId;
		if (!id) return;
		const request = this.requests.get(id);
		if (!request) return;
		clearTimeout(request.timer);
		this.requests.delete(id);
		request.reject(new Error('History recovery superseded'));
	}

	private handleTyping(params: JsonObject | undefined): void {
		if (!params || typeof params.room_id !== 'string' || !isJsonObject(params.from)) return;
		if (typeof params.from.user_id !== 'string') return;
		const key = `${params.room_id}:${params.from.user_id}`;
		const current = this.typing.get(key);
		if (current?.timer) clearTimeout(current.timer);
		const active = params.active !== false;
		if (!active) {
			this.typing.delete(key);
			this.emit();
			return;
		}
		const timeout = typeof params.timeout === 'number' && params.timeout > 0 ? params.timeout : 10;
		const state: TypingState = {
			room: params.room_id,
			from: params.from as Identity,
			active: true,
			timer: setTimeout(() => {
				this.typing.delete(key);
				this.emit();
			}, timeout * 1000)
		};
		this.typing.set(key, state);
		this.emit();
	}

	private handleResponse(id: string, result: JsonObject, rpcError?: RpcError): void {
		const request = this.requests.get(id);
		if (!request) return;
		this.requests.delete(id);
		clearTimeout(request.timer);
		if (rpcError) request.reject(this.errorFromRpc(rpcError));
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
			return { id, promise: Promise.reject(new Error('Finish signing in before sending requests')) };
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
		if (this.canSend(request)) this.sendRequest(request);
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
		this.rooms.clear();
		this.activeRoomId = undefined;
		this.server = undefined;
		this.you = undefined;
		this.authenticated = false;
		this.authRequested = false;
		this.registeredSession = false;
		this.passkeyRequired = false;
		this.error = undefined;
		this.clearTyping();
		this.emit();
	}

	private clearTyping(): void {
		for (const typing of this.typing.values()) {
			if (typing.timer) clearTimeout(typing.timer);
		}
		this.typing.clear();
	}

	private handleConnectionFailure(id: number, message: string): void {
		if (id !== this.connectionId) return;
		this.error = message;
		this.status = this.running ? 'reconnecting' : 'offline';
		if (this.running) this.scheduleReconnect();
		this.emit();
	}

	private scheduleReconnect(delayOverride?: number): void {
		if (!this.running || this.reconnectTimer) return;
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

export function timelineMessages(room: RoomSnapshot | undefined): MessageRecord[] {
	return room ? timelineEvents(room.timeline) : [];
}

export function defaultWebSocketUrl(locationLike?: Location): string {
	if (!locationLike) return 'ws://localhost:8080/ws';
	const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${protocol}//${locationLike.host}/ws`;
}

export function normalizeWebSocketUrl(input: string, locationLike?: Location): string {
	const value = input.trim();
	if (!value) return defaultWebSocketUrl(locationLike);
	if (value.startsWith('ws://') || value.startsWith('wss://')) return ensureWebSocketPath(value);
	if (value.startsWith('http://') || value.startsWith('https://')) {
		return ensureWebSocketPath(value.replace(/^http/, 'ws'));
	}
	if (value.startsWith('/')) {
		const base = locationLike ? `${locationLike.protocol === 'https:' ? 'wss:' : 'ws:'}//${locationLike.host}` : 'ws://localhost:5173';
		return `${base}${value}`;
	}
	return ensureWebSocketPath(`ws://${value}`);
}

function ensureWebSocketPath(value: string): string {
	const parsed = new URL(value);
	if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = '/ws';
	return parsed.toString();
}

function makeRequestId(method: string): string {
	const random = globalThis.crypto?.randomUUID?.();
	return `${method}_${random ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function incrementLogId(id: string): string {
	try {
		return (BigInt(id) + 1n).toString();
	} catch {
		return id;
	}
}

function increment(id: string): string {
	return incrementLogId(id);
}

function decrement(id: string): string {
	try {
		const value = BigInt(id);
		return value > 1n ? (value - 1n).toString() : '0';
	} catch {
		return '0';
	}
}

/** The zero boundary is a protocol sentinel before the first positive log ID. */
function nextRecoveryBoundary(after: string): string {
	return after === '0' ? '1' : after;
}

/** Return the next lower bound for checkpoint C, respecting the floor. */
function nextRecoveryAfter(checkpoint: string, floor: string): string {
	if (checkpoint === '0' && floor === '1') return '0';
	const candidate = increment(checkpoint);
	return maxLogId(candidate, floor);
}

function maxLogId(a: string, b: string): string {
	return compareWireHead(a, b) >= 0 ? a : b;
}

function compareWireHead(a: string, b: string): number {
	if (a === b) return 0;
	if (a === '0') return -1;
	if (b === '0') return 1;
	return compareLogIds(a, b);
}

function transitionBytes(transition: Transition): number {
	try {
		return new TextEncoder().encode(JSON.stringify(transition)).byteLength;
	} catch {
		return MAX_HISTORY_BUFFER_BYTES + 1;
	}
}

/** Pure admission check used to keep live/recovery memory bounded. */
export function recoveryBufferFits(
	entryCount: number,
	bufferBytes: number,
	transition: Transition,
	maxEntries = MAX_HISTORY_BUFFER_ENTRIES,
	maxBytes = MAX_HISTORY_BUFFER_BYTES
): boolean {
	return entryCount < maxEntries && bufferBytes + transitionBytes(transition) <= maxBytes;
}

function retryAfterMilliseconds(error: RpcError): number | undefined {
	if (error.code !== -32002 || !isJsonObject(error.data) || typeof error.data.ms !== 'number') return undefined;
	if (!Number.isFinite(error.data.ms) || error.data.ms < 0) return undefined;
	return Math.min(RETRY_AFTER_MAX_MS, Math.ceil(error.data.ms));
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
	const base = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(5, boundedAttempt - 1));
	const jitter = 0.8 + Math.min(1, Math.max(0, random)) * 0.4;
	return Math.max(retryAfterMs ?? 0, Math.round(base * jitter));
}

function transitionId(transition: Transition): string {
	return transition.log_id;
}
