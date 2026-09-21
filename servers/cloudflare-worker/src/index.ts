import { DurableObject } from "cloudflare:workers";
import { AuthError, AuthTooLargeError, WebAuthnService, type ChallengeRecord, type CredentialRepository } from "./auth";
import { isAllowedOrigin, loadConfig, type RuntimeConfig } from "./config";
import { ADMISSION_BUDGET } from "./budget";
import { extractClientIp, hashIpKey, stripForwardingHeaders } from "./ip";
import {
	errorFromUnknown,
	FrameError,
	jsonString,
	objectParam,
	optionalString,
	parseFrame,
	positiveIntParam,
	protocolError,
	protocolReply,
	requiredString,
	utf8Bytes,
	type ProtocolError,
	type RequestFrame,
} from "./protocol";
import { Store, StoreError, type StoreConfig, type StoreThreadRecord, type StoreMutationInput } from "./store";

const OBJECT_NAME = "public-demo-v1";
const INTERNAL_IP_HEADER = "X-Apron-Trusted-IP-Key";
const ATTACHMENT_VERSION = 1;

type WebSocketConnection = WebSocket & {
	serializeAttachment?: (value: unknown) => void;
	deserializeAttachment?: () => unknown;
};

interface ConnectionAttachment {
	v: 1;
	connId: string;
	ipKey: string;
	tier: "pending" | "anonymous" | "registered";
	userId?: string;
	name?: string;
	origin?: string;
	challenge?: ChallengeRecord;
	authDeadline: number;
	pendingFrames: number;
	pendingBytes: number;
	policyViolations: number[];
	historyInFlight: number;
	frameTimes: number[];
	closing?: boolean;
}

interface IdentityShape {
	user_id: string;
	name?: string;
	tier?: "anonymous" | "registered";
}

function randomId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function nowMs(): number {
	return Date.now();
}

function asStoreConfig(config: RuntimeConfig): Partial<StoreConfig> {
	const limits = config.limits;
	return {
		retentionMs: limits.retentionSeconds * 1_000,
		dedupTtlMs: limits.dedupTtlSeconds * 1_000,
		cleanupIntervalMs: limits.cleanupSeconds * 1_000,
		cleanupBatch: limits.cleanupBatch,
		maxSnapshotBytes: limits.maxSnapshotBytes,
		maxTextBytes: limits.maxTextBytes,
		maxNameBytes: limits.maxNameBytes,
		maxNameCodePoints: limits.maxNameCodePoints,
		maxEmbeds: limits.maxEmbeds,
		maxThreads: limits.threadLimit,
		maxThreadMetadataBytes: limits.threadMetadataBytes,
		maxHistoryLimit: limits.historyMaxLimit,
		historyDefaultLimit: limits.historyDefaultLimit,
		maxHistoryResponseBytes: limits.historyMaxResponseBytes,
		historyRequestsPerUserMinute: limits.historyRequestsPerUserMinute,
		historyRequestsPerIpMinute: limits.historyRequestsPerIpMinute,
		anonymousPostsPerMinute: limits.anonymousPostsPerMinute,
		anonymousPostsPerDay: limits.anonymousPostsPerDay,
		registeredPostsPerMinute: limits.registeredPostsPerMinute,
		registeredPostsPerDay: limits.registeredPostsPerDay,
		ipPostsPerMinute: limits.ipPostsPerMinute,
		ipPostsPerDay: limits.ipPostsPerDay,
		globalPostsPerMinute: limits.globalPostsPerMinute,
		globalPostsPerDay: limits.globalPostsPerDay,
		registrationsPerIpDay: limits.registrationsPerIpDay,
		registrationsPerDay: limits.registrationsPerDay,
		registeredIdentityCount: limits.registeredIdentityCount,
		authAttemptsPerIpMinute: limits.authAttemptsPerIpMinute,
		principalLimitCap: limits.limiterRecordCap,
		sqlReadsPerDay: limits.sqlReadsPerDay,
		sqlWritesPerDay: limits.sqlWritesPerDay,
		foregroundReadsPerDay: limits.foregroundReadsPerDay,
		foregroundWritesPerDay: limits.foregroundWritesPerDay,
		maintenanceReadsPerDay: limits.maintenanceReadsPerDay,
		maintenanceWritesPerDay: limits.maintenanceWritesPerDay,
		storageHighWaterBytes: limits.databaseHighWaterBytes,
		storageHardTargetBytes: limits.databaseHardTargetBytes,
		storageLowWaterBytes: limits.databaseResumeLowWaterBytes,
		admissionEnabled: !config.admissionOff,
		processedFramesPerDay: limits.processedFramesPerDay,
		framesPerIpMinute: limits.framesPerIpMinute,
		connectionAdmissionsPerIpMinute: limits.connectionAdmissionsPerIpMinute,
		connectionAdmissionsPerDay: limits.connectionAdmissionsPerDay,
	};
}

function trustedIpKey(request: Request): string | null {
	const value = request.headers.get(INTERNAL_IP_HEADER);
	return value && /^[A-Za-z0-9_-]{22}$/.test(value) ? value : null;
}

function challengeFromAttachment(value: unknown, connectionId: string): ChallengeRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<ChallengeRecord>;
	const boundedString = (input: unknown, max = 1_024): input is string => typeof input === "string" && input.length > 0 && input.length <= max;
	if (!boundedString(candidate.challengeId) || !/^[A-Za-z0-9_-]+$/.test(candidate.challengeId)) return undefined;
	if (!boundedString(candidate.challenge) || !/^[A-Za-z0-9_-]+$/.test(candidate.challenge)) return undefined;
	if (candidate.action !== "register" && candidate.action !== "login") return undefined;
	if (!boundedString(candidate.origin) || !boundedString(candidate.rpId)) return undefined;
	if (!Number.isSafeInteger(candidate.expiresAt)) return undefined;
	if (candidate.connectionId !== undefined && (!boundedString(candidate.connectionId) || candidate.connectionId !== connectionId)) return undefined;
	for (const key of ["identityUserId", "userId", "userHandle", "userName"] as const) {
		if (key === "identityUserId" && candidate[key] === null) continue;
		if (candidate[key] !== undefined && !boundedString(candidate[key])) return undefined;
	}
	return candidate as ChallengeRecord;
}

function connectionAttachment(socket: WebSocketConnection): ConnectionAttachment | null {
	try {
		const value = socket.deserializeAttachment?.();
		if (!value || typeof value !== "object") return null;
		const attachment = value as Partial<ConnectionAttachment>;
		if (attachment.v !== ATTACHMENT_VERSION || typeof attachment.connId !== "string" || typeof attachment.ipKey !== "string") return null;
		const challenge = challengeFromAttachment(attachment.challenge, attachment.connId);
		return {
			v: 1,
			connId: attachment.connId,
			ipKey: attachment.ipKey,
			tier: attachment.tier === "anonymous" || attachment.tier === "registered" ? attachment.tier : "pending",
			...(typeof attachment.userId === "string" ? { userId: attachment.userId } : {}),
			...(typeof attachment.name === "string" ? { name: attachment.name } : {}),
			...(typeof attachment.origin === "string" ? { origin: attachment.origin } : {}),
			...(challenge ? { challenge } : {}),
			authDeadline: typeof attachment.authDeadline === "number" ? attachment.authDeadline : 0,
			pendingFrames: typeof attachment.pendingFrames === "number" ? attachment.pendingFrames : 0,
			pendingBytes: typeof attachment.pendingBytes === "number" ? attachment.pendingBytes : 0,
			policyViolations: Array.isArray(attachment.policyViolations) ? attachment.policyViolations.filter((value): value is number => typeof value === "number").slice(-120) : [],
			historyInFlight: typeof attachment.historyInFlight === "number" ? attachment.historyInFlight : 0,
			frameTimes: Array.isArray(attachment.frameTimes) ? attachment.frameTimes.slice(-120) : [],
			...(attachment.closing ? { closing: true } : {}),
		};
	} catch {
		return null;
	}
}

function writeAttachment(socket: WebSocketConnection, attachment: ConnectionAttachment): void {
	// The attachment is intentionally limited to connection state. The runtime
	// rejects oversized attachments; keeping this assertion near serialization
	// makes that failure visible during development.
	const serialized = JSON.stringify(attachment);
	if (utf8Bytes(serialized) > 12_000) throw new Error("connection attachment exceeds safety budget");
	socket.serializeAttachment?.(attachment);
}

function openSocket(socket: WebSocketConnection): boolean {
	return socket.readyState === 1;
}

/** Async ceremonies must not overwrite counters for frames queued meanwhile. */
function writeSessionAttachment(socket: WebSocketConnection, attachment: ConnectionAttachment): void {
	const current = connectionAttachment(socket);
	if (current) {
		attachment.pendingFrames = current.pendingFrames;
		attachment.pendingBytes = current.pendingBytes;
		attachment.frameTimes = current.frameTimes;
		attachment.policyViolations = current.policyViolations;
		attachment.closing = current.closing;
	}
	writeAttachment(socket, attachment);
}

function errorToProtocol(error: unknown): ProtocolError {
	if (error instanceof AuthTooLargeError) return { name: "too_large", message: error.message };
	if (error instanceof AuthError) {
		return { name: "denied", message: error.message };
	}
	if (error instanceof StoreError) {
		if (error.code === "internal_error") return { name: "internal_error", message: "Demo temporarily unavailable" };
		return {
			name: error.code,
			message: error.message,
			...(error.data ? { data: error.data } : error.retryAfterMs !== undefined ? { data: { ms: Math.max(1, Math.trunc(error.retryAfterMs)) } } : {}),
		};
	}
	return errorFromUnknown(error);
}

function isUpgrade(request: Request): boolean {
	return request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function originAllowed(config: RuntimeConfig, request: Request): boolean {
	const origin = request.headers.get("Origin");
	return isAllowedOrigin(config, origin);
}

function responseError(status: number, message: string, retryAfter?: number): Response {
	const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	if (retryAfter !== undefined) headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfter / 1_000))));
	return new Response(JSON.stringify({ error: message }), { status, headers });
}

function asDecimalId(value: unknown, field: string, allowZero = true): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !/^\d+$/.test(value)) throw { name: "invalid_params", message: `${field} must be a decimal string` } satisfies ProtocolError;
	const number = Number(value);
	if (!Number.isSafeInteger(number) || (!allowZero && number === 0)) throw { name: "invalid_params", message: `${field} is outside the supported range` } satisfies ProtocolError;
	return String(number);
}

function passkeyCredentialParam(params: Record<string, unknown>, action: "register" | "login"): Record<string, unknown> {
	const credential = objectParam(params, "credential");
	if (!credential) throw { name: "invalid_params", message: "credential is required" } satisfies ProtocolError;
	const requiredCredentialString = (value: unknown, name: string): string => {
		if (typeof value !== "string" || value.length === 0) throw { name: "invalid_params", message: `credential.${name} must be a non-empty string` } satisfies ProtocolError;
		return value;
	};
	const id = requiredCredentialString(credential.id, "id");
	const rawId = requiredCredentialString(credential.rawId, "rawId");
	if (!/^[A-Za-z0-9_-]{1,1024}$/.test(id) || rawId !== id) throw { name: "invalid_params", message: "credential id must be unpadded base64url" } satisfies ProtocolError;
	if (credential.type !== "public-key") throw { name: "invalid_params", message: "credential.type must be public-key" } satisfies ProtocolError;
	const response = objectParam(credential, "response");
	if (!response) throw { name: "invalid_params", message: "credential.response is required" } satisfies ProtocolError;
	requiredCredentialString(response.clientDataJSON, "response.clientDataJSON");
	if (action === "register") requiredCredentialString(response.attestationObject, "response.attestationObject");
	else {
		requiredCredentialString(response.authenticatorData, "response.authenticatorData");
		requiredCredentialString(response.signature, "response.signature");
		if (response.userHandle !== undefined) requiredCredentialString(response.userHandle, "response.userHandle");
	}
	objectParam(credential, "clientExtensionResults");
	return credential;
}

function identityOf(attachment: ConnectionAttachment): IdentityShape | null {
	if (!attachment.userId || (attachment.tier !== "anonymous" && attachment.tier !== "registered")) return null;
	return { user_id: attachment.userId, ...(attachment.name ? { name: attachment.name } : {}), tier: attachment.tier };
}

function editableMessageParams(params: Record<string, unknown>): Record<string, unknown> {
	const message: Record<string, unknown> = Object.create(null);
	for (const [key, value] of Object.entries(params)) {
		if (["room_id", "message_id", "log_id", "body", "thread_id", "reply_message_id", "deleted"].includes(key)) continue;
		message[key] = value;
	}
	if (params.body !== undefined) message.body = params.body;
	if (params.thread_id !== undefined) message.thread_id = params.thread_id;
	if (params.reply_message_id !== undefined) message.reply_message_id = params.reply_message_id;
	if (params.deleted !== undefined) message.deleted = params.deleted;
	return message;
}

export async function fetchEntry(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const rootUpgrade = url.pathname === "/" && isUpgrade(request);
	if (url.pathname !== "/ws" && !rootUpgrade) {
		if (env.ASSETS) return env.ASSETS.fetch(request);
		return responseError(404, "Not found");
	}
	let config: RuntimeConfig;
	try {
		config = loadConfig(env);
	} catch {
		return responseError(503, "Configuration unavailable");
	}
	if (!originAllowed(config, request)) return responseError(403, "Origin not allowed");
	if (request.method !== "GET") return responseError(405, "Method not allowed");
	if (request.body !== null || (request.headers.has("Content-Length") && request.headers.get("Content-Length") !== "0") || request.headers.has("Transfer-Encoding")) {
		return responseError(400, "WebSocket upgrade must not contain a body");
	}
	if (!isUpgrade(request)) return responseError(400, "WebSocket upgrade required");
	const clientIp = extractClientIp(request.headers);
	if (!clientIp) return responseError(403, "Trusted client address unavailable");
	if (config.admissionOff) return responseError(503, "Demo admission is closed");
	const key = await hashIpKey(clientIp);
	// This counts attempts, including connections subsequently rejected by the DO.
	// Fail closed if the binding is absent or unavailable; never bypass admission.
	try {
		if (!env.CONNECTION_ATTEMPTS) return responseError(503, "Demo admission unavailable");
		const { success } = await env.CONNECTION_ATTEMPTS.limit({ key });
		if (!success) return responseError(429, "Connection attempts exceeded", ADMISSION_BUDGET.workerWindowSeconds * 1_000);
	} catch {
		return responseError(503, "Demo admission unavailable");
	}
	if (!env.DEMO) return responseError(503, "Demo capacity unavailable");
	const headers = stripForwardingHeaders(request.headers);
	headers.set(INTERNAL_IP_HEADER, key);
	headers.delete("content-length");
	const forwarded = new Request(request, { headers });
	const stub = env.DEMO.getByName(OBJECT_NAME);
	try { return await stub.fetch(forwarded); }
	catch { return responseError(503, "Demo capacity reached", 60_000); }
}

export default { fetch: fetchEntry };

export class ApronDemoServer extends DurableObject<Env> {
	private readonly config: RuntimeConfig;
	private readonly store: Store;
	private readonly webAuthn: WebAuthnService;
	private mutationTail: Promise<void> = Promise.resolve();
	private alarmTail: Promise<void> = Promise.resolve();
	private alarmFailures = 0;
	private alarmKnown = false;
	private readonly queues = new WeakMap<WebSocketConnection, Promise<void>>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.config = loadConfig(env);
		this.store = new Store(ctx as unknown as ConstructorParameters<typeof Store>[0], asStoreConfig(this.config));
		this.store.initialize();
		this.webAuthn = new WebAuthnService(this.config);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "GET" || !isUpgrade(request)) return responseError(400, "WebSocket upgrade required");
		const ipKey = trustedIpKey(request);
		if (!ipKey) return responseError(403, "Trusted client address unavailable");
		if (this.config.admissionOff) return responseError(503, "Demo admission is closed");
		const origin = request.headers.get("Origin");
		if (!isAllowedOrigin(this.config, origin)) return responseError(403, "Origin not allowed");
		try {
			const sockets = this.ctx.getWebSockets();
			const peers = sockets.map(socket => connectionAttachment(socket)).filter(peer => peer?.ipKey === ipKey);
			if (sockets.length >= this.config.limits.openConnections || peers.length >= this.config.limits.connectionsPerIp ||
				peers.filter(peer => peer?.tier !== "registered").length >= this.config.limits.anonymousConnectionsPerIp) {
				return responseError(429, "Demo capacity reached", 60_000);
			}
			this.store.reserveConnection({ ipKey, tier: "pending", now: nowMs() });
		} catch (error) {
			return this.storeResponseError(error);
		}
		const pair = new WebSocketPair();
		const server = pair[1] as WebSocketConnection;
		const attachment: ConnectionAttachment = {
			v: 1,
			connId: randomId("c"),
			ipKey,
			tier: "pending",
			...(origin ? { origin } : {}),
			authDeadline: nowMs() + this.config.limits.unauthenticatedTimeoutSeconds * 1_000,
			pendingFrames: 0,
			pendingBytes: 0,
			policyViolations: [],
			historyInFlight: 0,
			frameTimes: [],
		};
		this.ctx.acceptWebSocket(server);
		writeAttachment(server, attachment);
		this.send(server, this.serverAnnouncement(origin));
		await this.rescheduleAlarm();
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const socket = ws as WebSocketConnection;
		const attachment = connectionAttachment(socket);
		if (!attachment || attachment.closing) return Promise.resolve();
		if (typeof message !== "string") {
			this.closePolicy(socket, attachment, 1003, "Binary application frames are not supported");
			return Promise.resolve();
		}
		if (message.length > this.config.limits.maxFrameBytes || utf8Bytes(message) > this.config.limits.maxFrameBytes) {
			this.closePolicy(socket, attachment, 1009, "Frame exceeds the maximum size");
			return Promise.resolve();
		}
		const now = nowMs();
		attachment.frameTimes = attachment.frameTimes.filter(time => time > now - 60_000);
		if (attachment.frameTimes.length >= this.config.limits.framesPerConnectionMinute) {
			this.closePolicy(socket, attachment, 1008, "Frame rate limit reached");
			return Promise.resolve();
		}
		attachment.frameTimes.push(now);
		const bytes = utf8Bytes(message);
		if (attachment.pendingFrames >= this.config.limits.pendingFramesPerConnection || attachment.pendingBytes + bytes > this.config.limits.pendingBytesPerConnection) {
			this.closePolicy(socket, attachment, 1008, "Too many pending frames");
			return Promise.resolve();
		}
		attachment.pendingFrames += 1;
		attachment.pendingBytes += bytes;
		writeAttachment(socket, attachment);
		const prior = this.queues.get(socket) ?? Promise.resolve();
		const next = prior.catch(() => undefined).then(() => this.processFrame(socket, message)).catch((error) => this.handleFrameFailure(socket, error)).finally(() => {
			const latest = connectionAttachment(socket);
			if (latest) {
				latest.pendingFrames = Math.max(0, latest.pendingFrames - 1);
				latest.pendingBytes = Math.max(0, latest.pendingBytes - bytes);
				writeAttachment(socket, latest);
			}
		});
		this.queues.set(socket, next);
		return next;
	}

	async webSocketClose(ws: WebSocket, code = 1000): Promise<void> {
		const socket = ws as WebSocketConnection;
		const attachment = connectionAttachment(socket);
		if (!attachment) return;
		attachment.closing = true;
		writeAttachment(socket, attachment);
		try { socket.close(code === 1005 || code === 1006 ? 1000 : code); } catch { /* already closed */ }
		await this.rescheduleAlarm();
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		const socket = ws as WebSocketConnection;
		const attachment = connectionAttachment(socket);
		if (!attachment) return;
		attachment.closing = true;
		writeAttachment(socket, attachment);
		try { socket.close(1011, "Connection failed"); } catch { /* already closed */ }
		await this.rescheduleAlarm();
	}

	async alarm(): Promise<void> {
		this.alarmKnown = false;
		const now = nowMs();
		for (const ws of this.ctx.getWebSockets()) {
			const socket = ws as WebSocketConnection;
			const attachment = connectionAttachment(socket);
			if (!attachment) continue;
			if (attachment.tier === "pending" && attachment.authDeadline <= now) {
				this.closePolicy(socket, attachment, 1008, "Authentication timed out");
				continue;
			}
			if (attachment.challenge && attachment.challenge.expiresAt <= now) {
				delete attachment.challenge;
				writeAttachment(socket, attachment);
			}
		}
		try {
			const result = this.store.runCleanup(now);
			if (result?.did_work) this.announceRoomToAll();
			await this.rescheduleAlarm();
		} catch {
			// A metered maintenance failure is deferred. Do not spin an alarm loop.
			// The floor may already be durable even if a physical deletion failed.
			try { this.announceRoomToAll(); } catch { /* announcement also requires capacity */ }
			await this.rescheduleAlarm();
		}
	}

	private storeResponseError(error: unknown): Response {
		const protocol = errorToProtocol(error);
		const status = protocol.name === "retry_after" ? 429 : protocol.name === "denied" ? 403 : 503;
		const retry = protocol.data?.ms;
		return responseError(status, protocol.message, typeof retry === "number" ? retry : undefined);
	}

	private serverAnnouncement(origin: string | null): Record<string, unknown> {
		const limits = this.config.limits;
		return {
			method: "server",
			params: {
				protocol: 2,
				name: "apron-cloudflare-demo/1",
				caps: ["history", "edit"],
				auth: origin !== null && this.config.rpOrigins.includes(origin) ? ["webauthn", "anonymous"] : ["anonymous"],
				demo: {
					retention_seconds: limits.retentionSeconds,
					cleanup_seconds: limits.cleanupSeconds,
					max_frame_bytes: limits.maxFrameBytes,
					max_message_text_bytes: limits.maxTextBytes,
					max_snapshot_bytes: limits.maxSnapshotBytes,
					anonymous_posts_per_minute: limits.anonymousPostsPerMinute,
					registered_posts_per_minute: limits.registeredPostsPerMinute,
				},
			},
		};
	}

	private send(socket: WebSocketConnection, value: unknown): boolean {
		if (!openSocket(socket) || connectionAttachment(socket)?.closing) return false;
		try {
			socket.send(jsonString(value));
			return true;
		} catch {
			const attachment = connectionAttachment(socket);
			if (attachment) this.closePolicy(socket, attachment, 1011, "Delivery failed; reconnect to recover");
			return false;
		}
	}

	private reply(socket: WebSocketConnection, request: RequestFrame, result: unknown): void {
		if (request.id !== undefined) this.send(socket, protocolReply(request.id, result, request.full));
	}

	private fail(socket: WebSocketConnection, request: RequestFrame | null, error: ProtocolError): void {
		if (request && request.id === undefined) return;
		this.send(socket, protocolError(request?.id, error, request?.full ?? false));
	}

	private closePolicy(socket: WebSocketConnection, attachment: ConnectionAttachment, code: number, reason: string): void {
		attachment.policyViolations = [...attachment.policyViolations.filter((at) => at > nowMs() - 60_000), nowMs()];
		attachment.closing = true;
		writeAttachment(socket, attachment);
		try { socket.close(code, reason.slice(0, 120)); } catch { /* already closed */ }
	}

	private handleFrameFailure(socket: WebSocketConnection, error: unknown): void {
		if (error instanceof FrameError && error.closeCode !== undefined) {
			const attachment = connectionAttachment(socket);
			if (attachment) this.closePolicy(socket, attachment, error.closeCode, error.protocol.message);
			return;
		}
		const attachment = connectionAttachment(socket);
		if (attachment) this.fail(socket, null, errorToProtocol(error));
	}

	private async processFrame(socket: WebSocketConnection, raw: string | ArrayBuffer): Promise<void> {
		const attachment = connectionAttachment(socket);
		if (!attachment || attachment.closing) return;
		try {
			this.store.reserveFrames({ ipKey: attachment.ipKey, now: nowMs(), count: 1 });
		} catch (error) {
			const failure = errorToProtocol(error);
			if (failure.message.includes("Daily frame budget")) {
				for (const peer of this.ctx.getWebSockets()) {
					const state = connectionAttachment(peer);
					if (state) this.closePolicy(peer, state, 1013, "Demo capacity reached; try after daily reset");
				}
			} else this.closePolicy(socket, attachment, 1013, failure.message);
			return;
		}
		let parsed;
		try {
			parsed = parseFrame(raw, {
				maxFrameBytes: this.config.limits.maxFrameBytes,
				maxJsonDepth: this.config.limits.maxJsonDepth,
				maxJsonNodes: this.config.limits.maxJsonNodes,
				maxRequestIdBytes: this.config.limits.maxRequestIdBytes,
			});
		} catch (error) {
			if (error instanceof FrameError) {
				const request = error.id === null ? null : { method: "", params: {}, id: error.id, full: error.full };
				if (!error.notification) this.fail(socket, request, error.protocol);
				this.recordViolation(socket, error.protocol);
				if (error.closeCode !== undefined) {
					const latest = connectionAttachment(socket);
					if (latest) this.closePolicy(socket, latest, error.closeCode, error.protocol.message);
				}
				return;
			}
			throw error;
		}
		const request = parsed.request;
		try {
			await this.dispatch(socket, attachment, request);
		} catch (error) {
			const failure = errorToProtocol(error);
			this.fail(socket, request, failure);
			this.recordViolation(socket, failure);
		}
		if (!this.alarmKnown) await this.rescheduleAlarm();
	}

	private async dispatch(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		switch (request.method) {
			case "auth":
				await this.handleAuth(socket, attachment, request);
				return;
			case "history":
				await this.handleHistory(socket, attachment, request);
				return;
			case "message":
				await this.handleMessage(socket, attachment, request);
				return;
			case "thread":
				await this.handleThread(socket, attachment, request);
				return;
			default:
				if (request.id !== undefined) throw { name: "unsupported", message: "Unsupported method" } satisfies ProtocolError;
		}
	}

	private async handleAuth(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		// Authentication ceremonies are request/response exchanges. Ignore auth
		// notifications before reserving any attempt or changing attachment state.
		if (request.id === undefined && request.params.scheme === "webauthn") return;
		this.store.reserveAuthAttempt({ ipKey: attachment.ipKey, now: nowMs() });
		const params = request.params;
		const scheme = requiredString(params, "scheme");
		if (scheme === "anonymous") {
			if (attachment.tier === "anonymous" || attachment.tier === "registered") {
				this.reply(socket, request, { you: identityOf(attachment) });
				return;
			}
			const userId = randomId("guest");
			attachment.tier = "anonymous";
			attachment.userId = userId;
			attachment.name = `Guest ${userId.slice(-6)}`.slice(0, Math.min(this.config.limits.maxNameCodePoints, this.config.limits.maxNameBytes));
			writeAttachment(socket, attachment);
			this.reply(socket, request, { you: identityOf(attachment) });
			this.announceAuthenticated(socket, attachment);
			await this.rescheduleAlarm();
			return;
		}
		if (scheme !== "webauthn") throw { name: "unsupported", message: "Unsupported authentication scheme" } satisfies ProtocolError;
		if (attachment.tier === "registered") throw { name: "denied", message: "Identity switching requires reconnect" } satisfies ProtocolError;
		const action = requiredString(params, "action");
		if (action !== "register" && action !== "login") throw { name: "invalid_params", message: "Unknown passkey action" } satisfies ProtocolError;
		const step = requiredString(params, "step");
		const origin = this.requestOrigin(socket);
		if (!origin || !this.config.rpOrigins.includes(origin)) throw { name: "denied", message: "Frontend origin is not configured for passkeys" } satisfies ProtocolError;
		if (step === "begin") {
			const identity = action === "register" ? identityOf(attachment) : undefined;
			const begun = await this.webAuthn.begin(action, origin, nowMs(), identity ?? undefined, [], attachment.connId);
			if (connectionAttachment(socket)?.closing || !openSocket(socket)) return;
			attachment.challenge = begun.challenge;
			writeSessionAttachment(socket, attachment);
			this.reply(socket, request, { challenge_id: begun.challenge.challengeId, public_key: begun.publicKey });
			await this.rescheduleAlarm();
			return;
		}
		if (step !== "finish") throw { name: "invalid_params", message: "Passkey step must be begin or finish" } satisfies ProtocolError;
		const challengeId = requiredString(params, "challenge_id");
		const challenge = attachment.challenge;
		// A matching finish consumes the pending ceremony before any proof work,
		// including malformed proof data or failed verification. A finish naming a
		// different challenge is denied without destroying the usable ceremony.
		const matchingChallenge = challenge?.challengeId === challengeId;
		if (matchingChallenge) {
			delete attachment.challenge;
			writeAttachment(socket, attachment);
		}
		if (!challenge || !matchingChallenge || challenge.action !== action) throw { name: "denied", message: "Passkey challenge is missing or expired" } satisfies ProtocolError;
		const credential = passkeyCredentialParam(params, action);
		const repository: CredentialRepository = {
			getCredential: (credentialId) => this.store.getCredential(credentialId),
			getIdentity: (userId) => {
				const identity = this.store.getIdentity(userId);
				return identity ? { user_id: identity.userId, name: identity.name, tier: "registered" } : null;
			},
			registerCredential: (input) => {
				const identity = this.store.registerIdentity(input);
				return { user_id: identity.userId, name: identity.name, tier: "registered" };
			},
			updateCredentialCounter: (credentialId, counter) => this.store.updateCredentialCounter(credentialId, counter),
		};
		const finished = await this.webAuthn.finish(challenge, challengeId, credential, repository, {
			now: nowMs(),
			ipKey: attachment.ipKey,
			identity: identityOf(attachment) ?? undefined,
			connectionId: attachment.connId,
		});
		const latest = connectionAttachment(socket);
		if (!latest || latest.closing || !openSocket(socket)) return;
		const activeForUser = this.ctx.getWebSockets().filter(peer => peer !== socket && connectionAttachment(peer)?.userId === finished.identity.user_id).length;
		if (activeForUser >= this.config.limits.registeredConnectionsPerUser) throw { name: "retry_after", message: "Demo capacity reached", data: { ms: 60_000 } } satisfies ProtocolError;
		attachment.tier = "registered";
		attachment.userId = finished.identity.user_id;
		attachment.name = finished.identity.name;
		writeSessionAttachment(socket, attachment);
		this.reply(socket, request, { you: identityOf(attachment) });
		this.announceAuthenticated(socket, attachment);
		await this.rescheduleAlarm();
	}

	private requestOrigin(socket: WebSocketConnection): string | null {
		const attachment = connectionAttachment(socket) as ConnectionAttachment & { origin?: string } | null;
		return attachment?.origin ?? null;
	}

	private announceAuthenticated(socket: WebSocketConnection, attachment: ConnectionAttachment): void {
		try {
			const room = this.store.getRoomState();
			const threads = this.store.getThreads();
			const roomFrame = {
				method: "room",
				params: {
					room_id: room.room_id ?? "general",
					name: room.name ?? "General",
					latest_log_id: room.latest_log_id,
					history_log_id: room.history_log_id,
					...(room.topic ? { topic: room.topic } : {}),
				},
			};
			this.send(socket, roomFrame);
			if (Array.isArray(threads)) for (const thread of threads) this.send(socket, { method: "thread", params: thread });
		} catch {
			// A session without its initial room boundary cannot safely receive live entries.
			this.closePolicy(socket, attachment, 1013, "History temporarily unavailable; reconnect later");
		}
	}

	private async handleHistory(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate before loading history" } satisfies ProtocolError;
		if (attachment.historyInFlight >= this.config.limits.concurrentHistoryPerConnection) throw { name: "retry_after", message: "History request already in progress", data: { ms: 250 } } satisfies ProtocolError;
		const params = request.params;
		const roomId = optionalString(params, "room_id") ?? "general";
		if (roomId !== "general") throw { name: "invalid_params", message: "Unknown room" } satisfies ProtocolError;
		const after = asDecimalId(params.after, "after");
		const before = asDecimalId(params.before, "before");
		const limit = positiveIntParam(params, "limit");
		const threadId = optionalString(params, "thread_id");
		attachment.historyInFlight += 1;
		writeAttachment(socket, attachment);
		try {
			const page = this.store.history({
				roomId,
				after: after === undefined ? undefined : BigInt(after),
				before: before === undefined ? undefined : BigInt(before),
				limit: limit ?? this.config.limits.historyDefaultLimit,
				threadId,
				maxBytes: this.config.limits.historyMaxResponseBytes,
				now: nowMs(),
				userId: attachment.userId,
				ipKey: attachment.ipKey,
			});
			this.reply(socket, request, page);
		} finally {
			const latest = connectionAttachment(socket);
			if (latest) {
				latest.historyInFlight = Math.max(0, latest.historyInFlight - 1);
				writeAttachment(socket, latest);
			}
		}
	}

	private async handleMessage(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity) throw { name: "denied", message: "Authenticate before posting" } satisfies ProtocolError;
		const roomId = optionalString(request.params, "room_id") ?? "general";
		if (roomId !== "general") throw { name: "invalid_params", message: "Unknown room" } satisfies ProtocolError;
		if (request.params.log_id !== undefined) throw { name: "invalid_params", message: "Clients cannot supply log_id" } satisfies ProtocolError;
		const messageId = optionalString(request.params, "message_id");
		const body = request.params.body;
		if (messageId === undefined && body === undefined) throw { name: "invalid_params", message: "Missing body" } satisfies ProtocolError;
		if (body !== undefined) objectParam(request.params, "body");
		const input: StoreMutationInput = {
			userId: identity.user_id,
			tier: identity.tier,
			ipKey: attachment.ipKey,
			requestId: request.id,
			method: "message",
			roomId,
			now: nowMs(),
			messageId,
			message: editableMessageParams(request.params),
			body: body as Record<string, unknown> | undefined,
			threadId: optionalString(request.params, "thread_id"),
			replyMessageId: optionalString(request.params, "reply_message_id"),
			deleted: request.params.deleted === true,
			params: request.params,
			identity,
		};
		await this.runMutation(async () => {
			const result = this.store.mutate(input);
			if (result?.deduplicated) {
				this.reply(socket, request, result.result);
				return;
			}
			this.reply(socket, request, result.result);
			if (result.transition) this.broadcastTransition(result.transition, request.id);
		});
	}

	private async handleThread(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity) throw { name: "denied", message: "Authenticate before creating a thread" } satisfies ProtocolError;
		const roomId = optionalString(request.params, "room_id") ?? "general";
		if (roomId !== "general") throw { name: "invalid_params", message: "Unknown room" } satisfies ProtocolError;
		const input: StoreMutationInput = {
			userId: identity.user_id,
			tier: identity.tier,
			ipKey: attachment.ipKey,
			requestId: request.id,
			method: "thread",
			roomId,
			now: nowMs(),
			thread: {
				threadId: optionalString(request.params, "thread_id"),
				title: optionalString(request.params, "title"),
				summary: optionalString(request.params, "summary"),
				rootMessageId: optionalString(request.params, "root_message_id"),
			},
			params: request.params,
			identity,
		};
		await this.runMutation(async () => {
			const result = this.store.mutateThread(input);
			this.reply(socket, request, result.result);
			if (result.thread) this.broadcastThread(result.thread, request.id);
		});
	}

	private async runMutation(fn: () => Promise<void>): Promise<void> {
		const prior = this.mutationTail;
		let release!: () => void;
		this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
		await prior;
		try { await fn(); }
		catch (error) {
			if (!(error instanceof StoreError) || error.code === "internal_error") {
				// A platform/accounting failure may make commit visibility uncertain.
				// Force recovery so no recipient can silently skip a durable transition.
				for (const peer of this.ctx.getWebSockets()) {
					const state = connectionAttachment(peer);
					if (state) this.closePolicy(peer, state, 1011, "Delivery interrupted; reconnect to recover");
				}
			}
			throw error;
		} finally { release(); }
	}

	private broadcastTransition(transition: { room_id: string; log_id: string; message: Record<string, unknown> }, echo?: string): void {
		this.broadcast({
			method: "message",
			params: {
				room_id: transition.room_id,
				log_id: transition.log_id,
				...(echo !== undefined ? { echo } : {}),
				message: transition.message,
			},
		});
	}

	private broadcastThread(thread: StoreThreadRecord, echo?: string): void {
		this.broadcast({ method: "thread", params: { ...thread, room_id: "general", ...(echo !== undefined ? { echo } : {}) } });
	}

	private broadcast(value: unknown, only?: WebSocketConnection): void {
		for (const ws of this.ctx.getWebSockets()) {
			const socket = ws as WebSocketConnection;
			if (only && socket !== only) continue;
			const attachment = connectionAttachment(socket);
			if (!attachment || attachment.closing || (attachment.tier !== "anonymous" && attachment.tier !== "registered")) continue;
			if (!this.send(socket, value)) {
				attachment.closing = true;
				writeAttachment(socket, attachment);
				try { socket.close(1011, "Delivery failed; reconnect to recover"); } catch { /* closed */ }
			}
		}
	}

	private announceRoomToAll(): void {
		const room = this.store.getRoomState();
		this.broadcast({ method: "room", params: { room_id: "general", name: room.name ?? "General", latest_log_id: room.latest_log_id, history_log_id: room.history_log_id, ...(room.topic ? { topic: room.topic } : {}) } });
	}

	private recordViolation(socket: WebSocketConnection, error: ProtocolError): void {
		if (!["parse_error", "invalid_request", "invalid_params", "too_large"].includes(error.name)) return;
		const state = connectionAttachment(socket);
		if (!state || state.closing) return;
		state.policyViolations = [...state.policyViolations.filter(time => time > nowMs() - 60_000), nowMs()];
		if (state.policyViolations.length >= this.config.limits.repeatedPolicyViolations) this.closePolicy(socket, state, 1008, "Repeated policy violations");
		else writeAttachment(socket, state);
	}

	private rescheduleAlarm(): Promise<void> {
		const task = this.alarmTail.catch(() => undefined).then(async () => {
			let deadline: number | undefined;
			for (const socket of this.ctx.getWebSockets()) {
				const state = connectionAttachment(socket);
				if (!state || state.closing) continue;
				const due = [state.tier === "pending" ? state.authDeadline : undefined, state.challenge?.expiresAt]
					.filter((value): value is number => value !== undefined);
				for (const value of due) deadline = deadline === undefined ? value : Math.min(deadline, value);
			}
			await this.store.scheduleAlarm(deadline, nowMs());
			this.alarmKnown = true;
		});
		this.alarmTail = task;
		// A failed alarm setup remains recoverable on the next admitted activity.
		return task.catch(() => {
			this.alarmKnown = false;
			this.alarmFailures++;
			if ((this.alarmFailures & (this.alarmFailures - 1)) === 0) console.warn(JSON.stringify({ event: "alarm_setup_failed", count: this.alarmFailures }));
		});
	}
}
