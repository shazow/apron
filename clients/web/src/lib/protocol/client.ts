import {
	applyTransition,
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
	type EventRecord,
	type JsonObject,
	type RpcError,
	type ServerParams,
	type Sender,
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
	sender: Sender;
	active: boolean;
}

export interface ClientSnapshot {
	status: ConnectionStatus;
	error?: string;
	server?: ServerParams;
	you?: Sender;
	rooms: RoomSnapshot[];
	activeRoom?: string;
	pending: PendingOperation[];
	typing: TypingSnapshot[];
	showReconnectDivider: boolean;
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
	recovery?: RecoveryState;
}

interface RecoveryState {
	head: string;
	nextAfter: string;
	buffer: Transition[];
	replay: TimelineReplay;
	requestId?: string;
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
	sender: Sender;
	active: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 20_000;
const HISTORY_PAGE_SIZE = 200;
const MAX_RECONNECT_DELAY_MS = 10_000;

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
	private activeRoomId?: string;
	private server?: ServerParams;
	private you?: Sender;
	private displayName = '';
	private status: ConnectionStatus = 'idle';
	private error?: string;
	private showReconnectDivider = false;

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
				if (isJsonObject(result.you) && typeof result.you.id === 'string') this.you = result.you as Sender;
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
			error: this.error,
			server: this.server,
			you: this.you,
			rooms: [...this.rooms.values()].map((room) => ({ ...room, recovering: Boolean(room.recovery) })),
			activeRoom: this.activeRoomId,
			pending: [...this.requests.values()]
				.filter((request) => request.visible)
				.map(({ id, method, params, createdAt }) => ({
					id,
					method,
					room: typeof params.room === 'string' ? params.room : undefined,
					createdAt
				})),
			typing: [...this.typing.values()]
				.filter((entry) => entry.active)
				.map(({ room, sender, active }) => ({ room, sender, active })),
			showReconnectDivider: this.showReconnectDivider
		};
	}

	sendMessage(room: string, text: string, format: 'plain' | 'markdown' = 'markdown', thread?: string): OperationHandle {
		return this.enqueueRequest('send', {
			room,
			body: { text, format },
			...(thread !== undefined ? { thread } : {})
		}, { visible: true, allowBeforeAuth: false });
	}

	/** A fresh ID proposes a thread; null returns the message to the room. */
	setMessageThread(room: string, target: string, thread: string | null): OperationHandle {
		return this.enqueueRequest('update_request', {
			room,
			target,
			set: { thread }
		}, { visible: true, allowBeforeAuth: false });
	}

	updateMessage(room: string, target: string, text: string, format: 'plain' | 'markdown' = 'markdown'): OperationHandle {
		return this.enqueueRequest('update_request', {
			room,
			target,
			set: { body: { text, format } }
		}, { visible: true, allowBeforeAuth: false });
	}

	deleteMessage(room: string, target: string): OperationHandle {
		return this.enqueueRequest('update_request', {
			room,
			target,
			set: { deleted: true, body: null }
		}, { visible: true, allowBeforeAuth: false });
	}

	sendTyping(room: string, active: boolean): void {
		if (!this.authenticated || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
		this.sendFrame({ method: 'typing', params: { room, active, timeout: 8 } });
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
		if (frame.method === 'event') {
			this.handleEvent(frame.params);
			return;
		}
		if (frame.method === 'update') {
			this.handleUpdate(frame.params);
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
			...(typeof params.upload === 'string' ? { upload: params.upload } : {})
		};
		if (this.authenticated || this.authRequested) {
			this.emit();
			return;
		}
		const scheme = auth.includes('anonymous') ? 'anonymous' : auth[0];
		this.authRequested = true;
		const request = this.enqueueRequest('auth', {
			scheme,
			client: 'bottomless-web/0.1'
		}, { visible: false, allowBeforeAuth: true });
		request.promise.then((result) => this.handleAuth(result)).catch((cause: Error) => {
			this.authRequested = false;
			this.error = cause.message;
			this.emit();
		});
	}

	private handleAuth(result: JsonObject): void {
		const identity = result.you;
		if (!isJsonObject(identity) || typeof identity.id !== 'string') {
			this.error = 'Server authentication response did not include an identity';
			this.emit();
			return;
		}
		this.you = identity as Sender;
		this.authenticated = true;
		this.authRequested = false;
		this.reconnectAttempt = 0;
		this.showReconnectDivider = this.showReconnectDivider || this.rooms.size > 0;
		if (this.displayName) this.sendNick();
		this.emit();
	}

	private handleRoom(params: JsonObject | undefined): void {
		if (!params || typeof params.room !== 'string') return;
		const roomId = params.room;
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
			recovering: false
		};
		room.name = typeof params.name === 'string' ? params.name : roomId;
		room.topic = typeof params.topic === 'string' ? params.topic : undefined;
		if (isLogId(params.latest_id)) room.latestId = params.latest_id;
		this.rooms.set(roomId, room);
		this.activeRoomId ??= roomId;
		if (this.server?.caps?.includes('history') && isLogId(params.latest_id) && !room.recovery) {
			this.startRecovery(room, params.latest_id);
		}
		this.emit();
	}

	private handleThread(params: JsonObject | undefined): void {
		if (!params || typeof params.room !== 'string' || typeof params.thread !== 'string') return;
		const room = this.rooms.get(params.room);
		if (!room) return;
		const remaining = room.threads.filter((thread) => thread.thread !== params.thread);
		if (params.removed === true) {
			room.threads = remaining;
		} else {
			const thread: ThreadAnnouncement = {
				room: params.room,
				thread: params.thread,
				name: typeof params.name === 'string' ? params.name : params.thread,
				...(typeof params.summary === 'string' ? { summary: params.summary } : {}),
				...(isLogId(params.root) ? { root: params.root } : {})
			};
			room.threads = [...remaining, thread];
		}
		this.emit();
	}

	private startRecovery(room: RoomState, head: string): void {
		room.timeline = createTimeline(room.id);
		room.recovery = { head, nextAfter: '0', buffer: [], replay: new TimelineReplay(room.timeline) };
		room.recoveryError = undefined;
		if (head === '0') {
			room.recovery = undefined;
			return;
		}
		this.requestHistoryPage(room);
	}

	private requestHistoryPage(room: RoomState): void {
		const recovery = room.recovery;
		if (!recovery || !this.authenticated) return;
		const request = this.enqueueRequest('history', {
			room: room.id,
			after: recovery.nextAfter,
			before: recovery.head,
			limit: HISTORY_PAGE_SIZE
		}, { visible: false, allowBeforeAuth: false });
		recovery.requestId = request.id;
		request.promise.then((result) => {
			if (room.recovery?.requestId !== request.id) return;
			this.applyHistoryPage(room, result);
		}).catch((cause: Error) => {
			if (!room.recovery || room.recovery.requestId !== request.id) return;
			room.recoveryError = cause.message;
			this.finishRecovery(room);
			this.emit();
		});
	}

	private applyHistoryPage(room: RoomState, result: JsonObject): void {
		const recovery = room.recovery;
		if (!recovery) return;
		if (!Array.isArray(result.entries) || typeof result.more !== 'boolean') {
			room.recoveryError = 'Invalid history response';
			this.finishRecovery(room);
			this.emit();
			return;
		}
		const entries = result.entries;
		const transitions = entries.map(toTransition).filter((entry): entry is Transition => Boolean(entry));
		recovery.replay.apply(transitions);
		const more = result.more;
		const lastId = typeof result.last_id === 'string' ? result.last_id : undefined;
		if (more && lastId && isLogId(lastId)) {
			const nextAfter = incrementLogId(lastId);
			if (compareLogIds(nextAfter, recovery.nextAfter) > 0) {
				recovery.nextAfter = nextAfter;
				recovery.requestId = undefined;
				this.requestHistoryPage(room);
				this.emit();
				return;
			}
		}
		if (more) {
			room.recoveryError = 'History pagination did not provide a valid continuation';
		}
		this.finishRecovery(room);
		this.emit();
	}

	private finishRecovery(room: RoomState): void {
		const recovery = room.recovery;
		if (!recovery) return;
		recovery.replay.apply(
			recovery.buffer.sort((a, b) => compareLogIds(transitionId(a), transitionId(b)))
		);
		room.timeline = recovery.replay.finish();
		room.recovery = undefined;
		this.showReconnectDivider = false;
	}

	private handleEvent(params: JsonObject | undefined): void {
		if (!params || typeof params.room !== 'string') return;
		const transition = toTransition(params.event);
		if (!transition || transition.kind !== 'creation') return;
		this.acceptTransition(params.room, transition);
	}

	private handleUpdate(params: JsonObject | undefined): void {
		if (!params || typeof params.room !== 'string') return;
		const transition = toTransition(params);
		if (!transition || transition.kind !== 'update') return;
		this.acceptTransition(params.room, transition);
	}

	private acceptTransition(roomId: string, transition: Transition): void {
		const room = this.rooms.get(roomId);
		if (!room) return;
		const id = transitionId(transition);
		if (isLogId(id) && (!room.latestId || compareLogIds(id, room.latestId) > 0)) room.latestId = id;
		if (room.recovery) room.recovery.buffer.push(transition);
		else room.timeline = applyTransition(room.timeline, transition);
		this.emit();
	}

	private handleTyping(params: JsonObject | undefined): void {
		if (!params || typeof params.room !== 'string' || !isJsonObject(params.sender)) return;
		if (typeof params.sender.id !== 'string') return;
		const key = `${params.room}:${params.sender.id}`;
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
			room: params.room,
			sender: params.sender as Sender,
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
		if (rpcError) request.reject(new Error(rpcError.message || `Request failed (${rpcError.code})`));
		else request.resolve(result);
		this.emit();
	}

	private enqueueRequest<T extends JsonObject = JsonObject>(
		method: string,
		params: JsonObject,
		options: { visible: boolean; allowBeforeAuth: boolean }
	): OperationHandle<T> {
		const id = makeRequestId(method);
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
		const delay = delayOverride ?? Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(5, this.reconnectAttempt - 1));
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connectNow();
		}, delay);
	}

	private isCurrentSocket(id: number, socket: WebSocket): boolean {
		return id === this.connectionId && this.socket === socket;
	}

	private emit(): void {
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}
}

export function timelineMessages(room: RoomSnapshot | undefined): EventRecord[] {
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

function transitionId(transition: Transition): string {
	return transition.kind === 'creation' ? transition.event.event_id : transition.event_id;
}
