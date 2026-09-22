import { DurableObject } from "cloudflare:workers";
import { AuthError, AuthTooLargeError, WebAuthnService, type ChallengeRecord, type CredentialRepository } from "./auth";
import { isAllowedOrigin, loadConfig, type RuntimeConfig } from "./config";
import { ACCOUNT_USAGE_POLICY, ADMISSION_BUDGET } from "./budget";
import { fetchAccountUsage, type AccountUsageSnapshot } from "./account-usage";
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
import { Store, StoreError, type Broadcast, type RoomRecord, type StoreConfig, type StoreMutationInput } from "./store";

const OBJECT_NAME = "public-demo-v1";
const INTERNAL_IP_HEADER = "X-Apron-Trusted-IP-Key";
const ATTACHMENT_VERSION = 1;
/** Key prefix for passkey session records in the object's key-value storage. */
const SESSION_KEY_PREFIX = "session:";
/** Ordered, advisory expiry entries. The session record remains authoritative. */
const SESSION_EXPIRY_PREFIX = "session-expiry:";
const SESSION_LEGACY_CURSOR_KEY = "session-legacy-cursor";
const SESSION_LEGACY_DONE_KEY = "session-legacy-done";
const SESSION_CLEANUP_BATCH = 16;
const MAX_SESSION_TOKEN_CHARS = 256;

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

/**
 * A bearer session minted by a verified passkey login (protocol Appendix C,
 * session resume). Stored under a SHA-256 key so the plaintext token never
 * rests in storage. Kept in key-value storage rather than the SQL store: it is
 * throwaway state with its own expiry and needs no schema migration.
 */
interface StoredSession {
	v: 1;
	userId: string;
	origin: string;
	expiresMs: number;
}

interface SessionExpiryEntry {
	v: 1;
	sessionKey: string;
	expiresMs: number;
}

interface IdentityShape {
	user_id: string;
	name?: string;
	tier?: "anonymous" | "registered";
}

function randomId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sessionKey(token: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
	return SESSION_KEY_PREFIX + Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sessionExpiryKey(expiresMs: number, sessionKeyValue: string): string {
	// Date.now() plus the configured lifetime is well below 16 decimal digits;
	// the fixed width keeps lexicographic KV listing ordered by expiry.
	return `${SESSION_EXPIRY_PREFIX}${Math.max(0, Math.trunc(expiresMs)).toString().padStart(16, "0")}:${sessionKeyValue.slice(SESSION_KEY_PREFIX.length)}`;
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
		reactionUsersPerMessage: limits.reactionUsersPerMessage,
		reactionEmojisPerUser: limits.reactionEmojisPerUser,
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

/** The wire identity (section 3.3); the internal quota tier stays private. */
function publicIdentity(attachment: ConnectionAttachment): { user_id: string; name?: string } | null {
	const identity = identityOf(attachment);
	return identity ? { user_id: identity.user_id, ...(identity.name ? { name: identity.name } : {}) } : null;
}

function identityOf(attachment: ConnectionAttachment): IdentityShape | null {
	if (!attachment.userId || (attachment.tier !== "anonymous" && attachment.tier !== "registered")) return null;
	return { user_id: attachment.userId, ...(attachment.name ? { name: attachment.name } : {}), tier: attachment.tier };
}

// Browsers hide failed WebSocket handshake responses. An explicit, read-only
// HTTP probe on the same URL exposes capacity errors without admitting a socket.
function isConnectionStatus(request: Request): boolean {
	return request.method === "GET" && new URL(request.url).searchParams.get("apron_connection_status") === "1" && !isUpgrade(request);
}

export async function fetchEntry(request: Request, env: Env): Promise<Response> {
	const response = await fetchConnection(request, env);
	if (!isConnectionStatus(request)) return response;
	const headers = new Headers(response.headers);
	headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Access-Control-Expose-Headers", "Retry-After");
	headers.set("Cache-Control", "no-store");
	return new Response(response.body, { status: response.status, headers });
}

async function fetchConnection(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const status = isConnectionStatus(request);
	const rootUpgrade = url.pathname === "/" && (isUpgrade(request) || status);
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
	if (!isUpgrade(request) && !status) return responseError(400, "WebSocket upgrade required");
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
	private readonly runtimeEnv: Env;
	private readonly store: Store;
	private readonly webAuthn: WebAuthnService;
	private mutationTail: Promise<void> = Promise.resolve();
	private alarmTail: Promise<void> = Promise.resolve();
	private alarmFailures = 0;
	private alarmKnown = false;
	private accountUsageEvents = 0;
	private accountUsageRetryAt = 0;
	private accountUsageFailureCount = 0;
	private accountUsageVerified = false;
	private accountUsageRefresh?: Promise<void>;
	private accountUsageSnapshot: AccountUsageSnapshot | null = null;
	private readonly queues = new WeakMap<WebSocketConnection, Promise<void>>();
	private sessionWorkTail: Promise<void> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.runtimeEnv = env;
		this.config = loadConfig(env);
		this.store = new Store(ctx as unknown as ConstructorParameters<typeof Store>[0], asStoreConfig(this.config));
		this.store.initialize();
		this.accountUsageSnapshot = this.store.accountUsageSnapshot();
		this.webAuthn = new WebAuthnService(this.config);
	}

	async fetch(request: Request): Promise<Response> {
		const status = isConnectionStatus(request);
		if (request.method !== "GET" || (!isUpgrade(request) && !status)) return responseError(400, "WebSocket upgrade required");
		const ipKey = trustedIpKey(request);
		if (!ipKey) return responseError(403, "Trusted client address unavailable");
		if (this.config.admissionOff) return responseError(503, "Demo admission is closed");
		this.noteAccountUsageActivity(this.runtimeEnv);
		if (this.accountUsageBlocked(nowMs())) return responseError(503, "Demo account capacity reached", 300_000);
		const origin = request.headers.get("Origin");
		if (!isAllowedOrigin(this.config, origin)) return responseError(403, "Origin not allowed");
		try {
			const sockets = this.ctx.getWebSockets();
			const peers = sockets.map(socket => connectionAttachment(socket)).filter(peer => peer?.ipKey === ipKey);
			if (sockets.length >= this.config.limits.openConnections || peers.length >= this.config.limits.connectionsPerIp ||
				peers.filter(peer => peer?.tier !== "registered").length >= this.config.limits.anonymousConnectionsPerIp) {
				return responseError(429, "Demo capacity reached", 60_000);
			}
			if (status) {
				this.store.checkConnectionBudget(nowMs());
				// This is advisory; the real upgrade still checks all admission gates.
				return Response.json({ available: true });
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
		this.noteAccountUsageActivity(this.runtimeEnv);
		if (this.accountUsageBlocked(nowMs())) {
			this.closePolicy(socket, attachment, 1013, "Demo account capacity reached; try later");
			return Promise.resolve();
		}
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
		await this.refreshAccountUsage(this.runtimeEnv, now, false);
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
		try { await this.sweepSessions(now); } catch { /* retried on the next alarm */ }
		try {
			const result = this.store.runCleanup(now);
			if (result.did_work) {
				// A moved floor changes rooms' history_log_id; unchanged announcements
				// are skipped only when the floor did not move.
				const floorMoved = result.history_floor !== result.previous_floor;
				this.announceRetention(result.removed_rooms, floorMoved ? this.store.listRooms(nowMs()) : []);
			}
			await this.rescheduleAlarm();
		} catch {
			// A metered maintenance failure is deferred. Do not spin an alarm loop.
			// The floor may already be durable even if a physical deletion failed.
			try { this.announceRetention([], this.store.listRooms(nowMs())); } catch { /* announcement also requires capacity */ }
			await this.rescheduleAlarm();
		}
	}

	private storeResponseError(error: unknown): Response {
		const protocol = errorToProtocol(error);
		const status = protocol.name === "retry_after" ? 429 : protocol.name === "denied" ? 403 : 503;
		const retry = protocol.data?.ms;
		const message = protocol.data?.reason === "daily_budget" ? "Daily demo capacity reached" : protocol.message;
		return responseError(status, message, typeof retry === "number" ? retry : undefined);
	}

	private serverAnnouncement(origin: string | null): Record<string, unknown> {
		const limits = this.config.limits;
		return {
			method: "server",
			params: {
				protocol: 3,
				name: "apron-cloudflare-demo/2",
				caps: ["history", "edit", "rooms", "reactions"],
				auth: origin !== null && this.config.rpOrigins.includes(origin) ? ["webauthn", "token", "guest"] : ["guest"],
				demo: {
					retention_seconds: limits.retentionSeconds,
					cleanup_seconds: limits.cleanupSeconds,
					max_frame_bytes: limits.maxFrameBytes,
					max_message_text_bytes: limits.maxTextBytes,
					max_snapshot_bytes: limits.maxSnapshotBytes,
					guest_posts_per_minute: limits.anonymousPostsPerMinute,
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
			case "room":
				await this.handleRoom(socket, attachment, request);
				return;
			case "room_join":
				await this.handleRoomJoin(socket, attachment, request);
				return;
			case "room_leave":
				await this.handleRoomLeave(socket, attachment, request);
				return;
			case "reactions":
				await this.handleReactions(socket, attachment, request);
				return;
			// `nick` is the demo client's older spelling of the protocol's `name`.
			case "name":
			case "nick":
				await this.handleName(socket, attachment, request);
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
		// Protocol v3 renamed the `anonymous` scheme to `guest`; the old name is
		// still accepted (section 3.2 permits any scheme under guest access).
		if (scheme === "guest" || scheme === "anonymous") {
			if (attachment.tier === "anonymous" || attachment.tier === "registered") {
				this.reply(socket, request, { you: publicIdentity(attachment) });
				return;
			}
			const userId = randomId("guest");
			attachment.tier = "anonymous";
			attachment.userId = userId;
			attachment.name = `Guest ${userId.slice(-6)}`.slice(0, Math.min(this.config.limits.maxNameCodePoints, this.config.limits.maxNameBytes));
			writeAttachment(socket, attachment);
			this.reply(socket, request, { you: publicIdentity(attachment) });
			this.announceAuthenticated(socket, attachment);
			await this.rescheduleAlarm();
			return;
		}
		if (scheme === "token") {
			await this.handleTokenResume(socket, attachment, request);
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
		this.assertRegisteredCapacity(socket, finished.identity.user_id);
		const token = await this.issueSession(finished.identity.user_id, origin, nowMs());
		if (connectionAttachment(socket)?.closing || !openSocket(socket)) return;
		attachment.tier = "registered";
		attachment.userId = finished.identity.user_id;
		attachment.name = finished.identity.name;
		writeSessionAttachment(socket, attachment);
		this.reply(socket, request, { you: publicIdentity(attachment), token });
		this.announceAuthenticated(socket, attachment);
		await this.rescheduleAlarm();
	}

	private assertRegisteredCapacity(socket: WebSocketConnection, userId: string): void {
		const activeForUser = this.ctx.getWebSockets().filter(peer => peer !== socket && connectionAttachment(peer)?.userId === userId).length;
		if (activeForUser >= this.config.limits.registeredConnectionsPerUser) throw { name: "retry_after", message: "Demo capacity reached", data: { ms: 60_000 } } satisfies ProtocolError;
	}

	/**
	 * Resumes a passkey session through the protocol's `token` scheme. The
	 * session must come from a ceremony on this same allowed origin and be
	 * unexpired; a successful resume renews it for a full lifetime. The token is
	 * not rotated, so several tabs may share one persisted token.
	 */
	private async handleTokenResume(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		return this.withSessionLock(() => this.handleTokenResumeLocked(socket, attachment, request));
	}

	private async handleTokenResumeLocked(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (attachment.tier === "registered") throw { name: "denied", message: "Identity switching requires reconnect" } satisfies ProtocolError;
		const origin = this.requestOrigin(socket);
		if (!origin || !this.config.rpOrigins.includes(origin)) throw { name: "denied", message: "Frontend origin is not configured for passkeys" } satisfies ProtocolError;
		const token = requiredString(request.params, "token");
		if (token.length > MAX_SESSION_TOKEN_CHARS) throw { name: "invalid_params", message: "token is too long" } satisfies ProtocolError;
		const key = await sessionKey(token);
		const session = await this.store.withMeterAsync("foreground", { reads: 1 }, () => this.ctx.storage.get<StoredSession>(key));
		const now = nowMs();
		const expired = { name: "denied", message: "Session expired; sign in with your passkey" } satisfies ProtocolError;
		if (!session || session.v !== 1 || session.origin !== origin || session.expiresMs <= now) {
			if (session && session.expiresMs <= now) {
				await this.store.withMeterAsync("foreground", { writes: 1 }, () => this.ctx.storage.delete(key));
			}
			throw expired;
		}
		const identity = this.store.getIdentity(session.userId);
		if (!identity) {
			await this.store.withMeterAsync("foreground", { writes: 1 }, () => this.ctx.storage.delete(key));
			throw expired;
		}
		if (connectionAttachment(socket)?.closing || !openSocket(socket)) return;
		this.assertRegisteredCapacity(socket, identity.userId);
		const renewed = { ...session, expiresMs: now + this.config.limits.sessionTtlSeconds * 1_000 };
		await this.store.withMeterAsync("foreground", { writes: 3 }, async () => {
			// The index is advisory. Writing it first means a crash cannot leave a
			// live session without an expiry entry; a stale entry is harmless.
			await this.ctx.storage.put<SessionExpiryEntry>(sessionExpiryKey(renewed.expiresMs, key), {
				v: 1, sessionKey: key, expiresMs: renewed.expiresMs,
			});
			await this.ctx.storage.put<StoredSession>(key, renewed);
			const oldIndex = sessionExpiryKey(session.expiresMs, key);
			const newIndex = sessionExpiryKey(renewed.expiresMs, key);
			if (oldIndex !== newIndex) await this.ctx.storage.delete(oldIndex);
		});
		if (connectionAttachment(socket)?.closing || !openSocket(socket)) return;
		attachment.tier = "registered";
		attachment.userId = identity.userId;
		attachment.name = identity.name;
		writeSessionAttachment(socket, attachment);
		this.reply(socket, request, { you: publicIdentity(attachment), token });
		this.announceAuthenticated(socket, attachment);
		await this.rescheduleAlarm();
	}

	private async issueSession(userId: string, origin: string, now: number): Promise<string> {
		return this.withSessionLock(() => this.issueSessionLocked(userId, origin, now));
	}

	private async issueSessionLocked(userId: string, origin: string, now: number): Promise<string> {
		const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
		const key = await sessionKey(token);
		const expiresMs = now + this.config.limits.sessionTtlSeconds * 1_000;
		await this.store.withMeterAsync("foreground", { writes: 2 }, async () => {
			await this.ctx.storage.put<SessionExpiryEntry>(sessionExpiryKey(expiresMs, key), { v: 1, sessionKey: key, expiresMs });
			await this.ctx.storage.put<StoredSession>(key, { v: 1, userId, origin, expiresMs });
		});
		return token;
	}

	/**
	 * Drops expired session records from a bounded expiry index. The separate
	 * legacy cursor gradually indexes records written before this index existed,
	 * so deployment does not require a destructive migration or an unbounded
	 * first alarm. Cursors advance only after their batch has completed.
	 */
	private async sweepSessions(now: number): Promise<void> {
		return this.withSessionLock(() => this.sweepSessionsLocked(now));
	}

	private async sweepSessionsLocked(now: number): Promise<void> {
		// Socket deadline alarms can be frequent. Probe the bounded expiry index
		// before reserving a full batch; after legacy migration this is the only
		// maintenance work performed until an expiry is actually due.
		const { legacyDone, dueProbe } = await this.store.withMeterAsync("maintenance", { reads: 2 }, async () => ({
			legacyDone: await this.ctx.storage.get<boolean>(SESSION_LEGACY_DONE_KEY),
			dueProbe: await this.ctx.storage.list<SessionExpiryEntry>({
				prefix: SESSION_EXPIRY_PREFIX,
				end: `${SESSION_EXPIRY_PREFIX}${Math.max(0, Math.trunc(now)).toString().padStart(16, "0")}\uffff`,
				limit: 1,
			}),
		}), now);
		if (legacyDone === true && dueProbe.size === 0) return;
		// Up to B index rows + B session reads + B legacy rows + cursor/control
		// reads; writes cover 2B expiry deletes + B legacy changes + 2 markers.
		await this.store.withMeterAsync("maintenance", {
			reads: 3 * SESSION_CLEANUP_BATCH + 4,
			writes: 3 * SESSION_CLEANUP_BATCH + 2,
		}, async () => {
			const indexed = await this.ctx.storage.list<SessionExpiryEntry>({
				prefix: SESSION_EXPIRY_PREFIX,
				end: `${SESSION_EXPIRY_PREFIX}${Math.max(0, Math.trunc(now)).toString().padStart(16, "0")}\uffff`,
				limit: SESSION_CLEANUP_BATCH,
			});
			for (const [indexKey, entry] of indexed) {
				if (!entry || entry.v !== 1 || typeof entry.sessionKey !== "string" || !Number.isSafeInteger(entry.expiresMs)) {
					await this.ctx.storage.delete(indexKey);
					continue;
				}
				const session = await this.ctx.storage.get<StoredSession>(entry.sessionKey);
				if (!session || session.v !== 1 || !Number.isSafeInteger(session.expiresMs)) {
					await this.ctx.storage.delete(indexKey);
					continue;
				}
				if (session.expiresMs <= now) {
					await this.ctx.storage.delete([entry.sessionKey, indexKey]);
					continue;
				}
				if (entry.expiresMs < session.expiresMs) {
					await this.ctx.storage.delete(indexKey);
					continue;
				}
				// This should only be reached for a stale/malformed ordering entry;
				// preserve the live session and discard its obsolete index row.
				await this.ctx.storage.delete(indexKey);
			}

			if (legacyDone === true) return;
			const legacyCursor = await this.ctx.storage.get<string>(SESSION_LEGACY_CURSOR_KEY);
			const legacy = await this.ctx.storage.list<StoredSession>({
				prefix: SESSION_KEY_PREFIX,
				...(legacyCursor ? { startAfter: legacyCursor } : {}),
				limit: SESSION_CLEANUP_BATCH,
			});
			let nextLegacyCursor: string | null = legacyCursor ?? null;
			for (const [key, session] of legacy) {
				if (!session || session.v !== 1 || !Number.isSafeInteger(session.expiresMs)) {
					nextLegacyCursor = key;
					continue;
				}
				if (session.expiresMs <= now) await this.ctx.storage.delete(key);
				else await this.ctx.storage.put<SessionExpiryEntry>(sessionExpiryKey(session.expiresMs, key), { v: 1, sessionKey: key, expiresMs: session.expiresMs });
				nextLegacyCursor = key;
			}
			if (legacy.size === 0 || legacy.size < SESSION_CLEANUP_BATCH) nextLegacyCursor = null;
			await this.ctx.storage.put(SESSION_LEGACY_CURSOR_KEY, nextLegacyCursor);
			if (nextLegacyCursor === null) await this.ctx.storage.put(SESSION_LEGACY_DONE_KEY, true);
		});
	}

	/** Serialize session KV decisions across fetches and alarms. */
	private async withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
		const prior = this.sessionWorkTail;
		let release!: () => void;
		const held = new Promise<void>(resolve => { release = resolve; });
		this.sessionWorkTail = prior.catch(() => undefined).then(() => held);
		await prior.catch(() => undefined);
		try {
			return await fn();
		} finally {
			release();
		}
	}

	private requestOrigin(socket: WebSocketConnection): string | null {
		const attachment = connectionAttachment(socket) as ConnectionAttachment & { origin?: string } | null;
		return attachment?.origin ?? null;
	}

	private announceAuthenticated(socket: WebSocketConnection, attachment: ConnectionAttachment): void {
		try {
			// Every room is visible to every authenticated client.
			for (const room of this.store.listRooms(nowMs())) this.send(socket, { method: "room", params: room });
		} catch {
			// A session without its initial room boundaries cannot safely receive live records.
			this.closePolicy(socket, attachment, 1013, "History temporarily unavailable; reconnect later");
		}
	}

	private async handleHistory(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate before loading history" } satisfies ProtocolError;
		if (attachment.historyInFlight >= this.config.limits.concurrentHistoryPerConnection) throw { name: "retry_after", message: "History request already in progress", data: { ms: 250 } } satisfies ProtocolError;
		const params = request.params;
		const roomId = requiredString(params, "room_id");
		const after = asDecimalId(params.after, "after");
		const before = asDecimalId(params.before, "before");
		const limit = positiveIntParam(params, "limit");
		attachment.historyInFlight += 1;
		writeAttachment(socket, attachment);
		try {
			const page = this.store.history({
				roomId,
				after,
				before,
				limit: limit ?? this.config.limits.historyDefaultLimit,
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

	private async handleName(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity || attachment.tier !== "registered") {
			throw { name: "denied", message: "Only registered users may change their name" } satisfies ProtocolError;
		}
		const name = requiredString(request.params, "name");
		await this.runMutation(async () => {
			const result = this.store.commitMutation({
				userId: identity.user_id, ipKey: attachment.ipKey,
				requestId: request.id, method: "name", now: nowMs(),
				params: request.params, identity,
			});
			// Persist first, then refresh every live attachment for this identity so
			// subsequent messages from other tabs carry the same name. An accepted
			// retry must not roll back a newer name change.
			if (!result.deduplicated) {
				for (const peer of this.ctx.getWebSockets()) {
					const state = connectionAttachment(peer);
					if (state?.userId !== identity.user_id) continue;
					state.name = name;
					writeAttachment(peer, state);
				}
			}
			const current = connectionAttachment(socket);
			if (current) this.reply(socket, request, { you: publicIdentity(current) });
		});
	}

	/** Shared path for logged mutations: dedup, quotas, commit, reply, broadcast. */
	private async commitAndBroadcast(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, method: "message" | "room" | "reactions", action: string): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity) throw { name: "denied", message: `Authenticate before ${action}` } satisfies ProtocolError;
		const input: StoreMutationInput = {
			userId: identity.user_id,
			tier: identity.tier,
			ipKey: attachment.ipKey,
			requestId: request.id,
			method,
			now: nowMs(),
			params: request.params,
			identity,
		};
		await this.runMutation(async () => {
			const result = this.store.mutate(input);
			this.reply(socket, request, result.result);
			// A deduplicated retry carries no records and is never rebroadcast.
			for (const record of result.broadcasts) this.broadcastRecord(record);
		});
	}

	private async handleMessage(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate before posting" } satisfies ProtocolError;
		requiredString(request.params, "room_id");
		if (request.params.log_id !== undefined) throw { name: "invalid_params", message: "Clients cannot supply log_id" } satisfies ProtocolError;
		const messageId = optionalString(request.params, "message_id");
		if (messageId === undefined && request.params.body === undefined) throw { name: "invalid_params", message: "Missing body" } satisfies ProtocolError;
		if (request.params.body !== undefined) objectParam(request.params, "body");
		await this.commitAndBroadcast(socket, attachment, request, "message", "posting");
	}

	private async handleRoom(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		await this.commitAndBroadcast(socket, attachment, request, "room", "changing rooms");
	}

	private async handleReactions(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		await this.commitAndBroadcast(socket, attachment, request, "reactions", "reacting");
	}

	/** Every room is visible to everyone; joining re-sends its announcement. */
	private async handleRoomJoin(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate before joining rooms" } satisfies ProtocolError;
		const roomId = requiredString(request.params, "room_id");
		const room = this.store.getRoom(roomId, nowMs());
		if (!room) throw { name: "invalid_params", message: "Unknown room" } satisfies ProtocolError;
		this.reply(socket, request, {});
		this.send(socket, { method: "room", params: room });
	}

	private async handleRoomLeave(_socket: WebSocketConnection, attachment: ConnectionAttachment, _request: RequestFrame): Promise<void> {
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate before leaving rooms" } satisfies ProtocolError;
		throw { name: "denied", message: "Every demo room stays visible to all clients" } satisfies ProtocolError;
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
				// Force recovery so no recipient can silently skip a durable record.
				for (const peer of this.ctx.getWebSockets()) {
					const state = connectionAttachment(peer);
					if (state) this.closePolicy(peer, state, 1011, "Delivery interrupted; reconnect to recover");
				}
			}
			throw error;
		} finally { release(); }
	}

	/**
	 * Broadcast one committed record. Every authenticated client sees every
	 * room, so a moved message's snapshot reaches both rooms' viewers in one
	 * frame, delivered once per connection (section 3.5).
	 */
	private broadcastRecord(record: Broadcast): void {
		this.broadcast({ method: record.method, params: record.params });
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

	/** Re-announce rooms after retention moved their boundaries, and removals. */
	private announceRetention(removed: readonly string[], rooms: readonly RoomRecord[]): void {
		for (const roomId of removed) this.broadcast({ method: "room", params: { room_id: roomId, removed: true } });
		for (const room of rooms) this.broadcast({ method: "room", params: room });
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

	private accountUsageBlocked(now: number): boolean {
		return this.accountUsageSnapshot?.day === new Date(now).toISOString().slice(0, 10) && this.accountUsageSnapshot.stop;
	}

	private noteAccountUsageActivity(env: Env): void {
		if (!env.ACCOUNT_ID || !env.ACCOUNT_ANALYTICS_TOKEN) return;
		this.accountUsageEvents += 1;
		const now = nowMs();
		const stale = !this.accountUsageSnapshot || now - this.accountUsageSnapshot.sampledAt >= ACCOUNT_USAGE_POLICY.staleAfterMs;
		if (this.accountUsageEvents < ACCOUNT_USAGE_POLICY.refreshEveryEvents && !stale) return;
		// Keep the refresh alive after the request returns without adding its latency
		// to the admitted WebSocket attempt.
		this.ctx.waitUntil(this.refreshAccountUsage(env, now, false));
	}

	private async refreshAccountUsage(env: Env, now: number, forced: boolean): Promise<void> {
		if (!env.ACCOUNT_ID || !env.ACCOUNT_ANALYTICS_TOKEN) return;
		if (this.accountUsageRefresh) return this.accountUsageRefresh;
		if (!forced && now < this.accountUsageRetryAt) return;
		if (this.accountUsageSnapshot && now - this.accountUsageSnapshot.sampledAt < ACCOUNT_USAGE_POLICY.minimumRefreshIntervalMs) return;
		this.accountUsageEvents = 0;
		const task = (async () => {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5_000);
			try {
				const snapshot = await fetchAccountUsage(env, now, controller.signal);
				// Bounded confirmation per instance and after recovery; no sensitive data.
				if (!this.accountUsageVerified || this.accountUsageFailureCount > 0) {
					console.info(JSON.stringify({ event: "account_usage_refresh_succeeded", sampledAt: snapshot.sampledAt, stop: snapshot.stop }));
				}
				this.accountUsageVerified = true;
				try { this.store.persistAccountUsageSnapshot(snapshot, now); } catch { /* retain the in-memory safety stop */ }
				this.accountUsageSnapshot = snapshot;
				this.accountUsageFailureCount = 0;
				this.accountUsageRetryAt = 0;
				if (snapshot.stop) {
					for (const peer of this.ctx.getWebSockets()) {
						const state = connectionAttachment(peer);
						if (state) this.closePolicy(peer as WebSocketConnection, state, 1013, "Demo account capacity reached; try later");
					}
				}
			} catch {
				this.accountUsageFailureCount += 1;
				const delay = Math.min(ACCOUNT_USAGE_POLICY.maxRetryMs, ACCOUNT_USAGE_POLICY.initialRetryMs * 2 ** Math.min(this.accountUsageFailureCount - 1, 4));
				this.accountUsageRetryAt = now + delay;
				if ((this.accountUsageFailureCount & (this.accountUsageFailureCount - 1)) === 0) console.warn(JSON.stringify({ event: "account_usage_refresh_failed", count: this.accountUsageFailureCount }));
			} finally {
				clearTimeout(timeout);
			}
		})();
		this.accountUsageRefresh = task;
		await task;
		this.accountUsageRefresh = undefined;
	}
}
