import { DurableObject } from "cloudflare:workers";
import { AuthError, AuthTooLargeError, WebAuthnService, type ChallengeRecord, type CredentialRepository } from "./auth";
import { isAllowedOrigin, loadConfig, type RuntimeConfig } from "./config";
import { ACCOUNT_USAGE_POLICY, ADMISSION_BUDGET, MAX_FRAME_LEASE, MAX_TYPE_THROTTLE_PER_MINUTE } from "./budget";
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
	retryAfterSeconds,
	utf8Bytes,
	type ProtocolError,
	type RequestFrame,
} from "./protocol";
import { Store, StoreError, type Broadcast, type StoreConfig, type StoreMutationInput } from "./store";

const OBJECT_NAME = "public-demo-v1";
const INTERNAL_IP_HEADER = "X-Apron-Trusted-IP-Key";
const ATTACHMENT_VERSION = 1;
/** Key prefix for passkey session records in the object's key-value storage. */
const SESSION_KEY_PREFIX = "session:";
/** Ordered, advisory expiry entries. The session record remains authoritative. */
const SESSION_EXPIRY_PREFIX = "session-expiry:";
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
	/** Per-type throttle events from this connection, oldest first (budget.ts). */
	throttles?: Partial<Record<ThrottledType, number[]>>;
	/** When this connection last got a `@server` throttle notice, per type. */
	notices?: Partial<Record<ThrottledType, number>>;
	/** Frames this connection has already reserved and not yet spent, for one UTC day. */
	frameLease?: { day: string; remaining: number };
	closing?: boolean;
}

/** Message types with their own per-user rate (budget.ts). */
type ThrottledType = "activity" | "room_list";
const THROTTLED_TYPES: readonly ThrottledType[] = ["activity", "room_list"];
const THROTTLE_WINDOW_MS = 60_000;
/** The system identity for server notices (Appendix J.1). */
const SERVER_IDENTITY = { user_id: "@server", name: "Server" } as const;

/**
 * A bearer session minted by a verified passkey login (protocol Appendix I,
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
			...throttleState(attachment),
			...(attachment.closing ? { closing: true } : {}),
		};
	} catch {
		return null;
	}
}

/** The throttle fields of a stored attachment, bounded and type-checked. */
function throttleState(attachment: Partial<ConnectionAttachment>): Pick<ConnectionAttachment, "throttles" | "notices" | "frameLease"> {
	const out: Pick<ConnectionAttachment, "throttles" | "notices" | "frameLease"> = {};
	const throttles: Partial<Record<ThrottledType, number[]>> = {};
	const notices: Partial<Record<ThrottledType, number>> = {};
	for (const type of THROTTLED_TYPES) {
		const events = attachment.throttles?.[type];
		if (Array.isArray(events)) throttles[type] = events.filter((value): value is number => typeof value === "number").slice(-MAX_TYPE_THROTTLE_PER_MINUTE);
		const notice = attachment.notices?.[type];
		if (typeof notice === "number") notices[type] = notice;
	}
	if (Object.keys(throttles).length) out.throttles = throttles;
	if (Object.keys(notices).length) out.notices = notices;
	const lease = attachment.frameLease;
	if (lease && typeof lease.day === "string" && Number.isSafeInteger(lease.remaining) && lease.remaining > 0) {
		out.frameLease = { day: lease.day, remaining: Math.min(lease.remaining, MAX_FRAME_LEASE) };
	}
	return out;
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
		attachment.throttles = current.throttles;
		attachment.notices = current.notices;
		attachment.frameLease = current.frameLease;
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
			...(error.retryAfterMs !== undefined
				? { data: { ...error.data, retry_after: retryAfterSeconds(error.retryAfterMs) } }
				: error.data ? { data: error.data } : {}),
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
	/**
	 * Room IDs known to exist (true) or not (false), so relaying activity needs
	 * no storage read. Lost on hibernation and refilled from listings, record
	 * broadcasts, and one lookup per unknown ID; bounded like the rooms table.
	 */
	private readonly knownRooms = new Map<string, boolean>();
	/**
	 * When each frame the server processed in the last minute arrived, oldest
	 * first, for `globalFramesPerMinute`. In memory: a hibernating object has
	 * received nothing, so a reset window loses no spike.
	 */
	private readonly recentFrames: number[] = [];
	private sessionWorkTail: Promise<void> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.runtimeEnv = env;
		this.config = loadConfig(env);
		this.store = new Store(ctx as unknown as ConstructorParameters<typeof Store>[0], asStoreConfig(this.config));
		this.webAuthn = new WebAuthnService(this.config);
		if (this.store.requiresReset()) {
			// Stored data from another schema version is wiped, not migrated. The
			// input gate holds every event until the fresh schema exists.
			void ctx.blockConcurrencyWhile(async () => {
				await this.store.resetStorage();
				this.accountUsageSnapshot = this.store.accountUsageSnapshot();
				console.warn(JSON.stringify({ event: "storage_schema_reset" }));
			});
		} else {
			this.store.initialize();
			this.accountUsageSnapshot = this.store.accountUsageSnapshot();
		}
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
		let result: ReturnType<Store["runCleanup"]> | undefined;
		try {
			result = this.store.runCleanup(now);
		} catch {
			// A metered maintenance failure is deferred. Do not spin an alarm loop.
			// The floor may already be durable even if a physical deletion failed,
			// so re-announce every room below.
		}
		// Committed removals need no store access; announce them before any
		// listing that could fail on an exhausted budget.
		for (const roomId of result?.removed_rooms ?? []) {
			this.noteRoom(roomId, false);
			this.broadcast({ method: "room", params: { room_id: roomId, removed: true } });
		}
		if (!result || result.history_floor !== result.previous_floor) {
			try {
				// Only rooms whose history_log_id moved need a new announcement.
				const rooms = this.store.listRooms(nowMs(), {
					maintenance: true,
					...(result ? { changedSinceFloor: Number(result.previous_floor) } : {}),
				});
				for (const room of rooms) this.broadcast({ method: "room", params: room });
			} catch { /* announcement also requires capacity; clients see the floor on their next history page */ }
		}
		await this.rescheduleAlarm();
	}

	private storeResponseError(error: unknown): Response {
		const protocol = errorToProtocol(error);
		const status = protocol.name === "retry_after" ? 429 : protocol.name === "denied" ? 403 : 503;
		const retry = protocol.data?.retry_after;
		const message = protocol.data?.reason === "daily_budget" ? "Daily demo capacity reached" : protocol.message;
		return responseError(status, message, typeof retry === "number" ? retry * 1_000 : undefined);
	}

	private serverAnnouncement(origin: string | null): Record<string, unknown> {
		const limits = this.config.limits;
		return {
			method: "server",
			params: {
				protocol: 4,
				name: "apron-cloudflare-demo/3",
				caps: ["history", "edit", "rooms", "reactions", ...(this.config.activityEnabled ? ["activity"] : [])],
				auth: origin !== null && this.config.rpOrigins.includes(origin) ? ["webauthn", "token", "guest"] : ["guest"],
				ext: {
					demo: {
						retention_seconds: limits.retentionSeconds,
						cleanup_seconds: limits.cleanupSeconds,
						max_frame_bytes: limits.maxFrameBytes,
						max_message_text_bytes: limits.maxTextBytes,
						max_snapshot_bytes: limits.maxSnapshotBytes,
						guest_posts_per_minute: limits.anonymousPostsPerMinute,
						registered_posts_per_minute: limits.registeredPostsPerMinute,
						server_frames_per_minute: limits.globalFramesPerMinute,
						room_list_per_minute: limits.roomListRequestsPerUserMinute,
						// With `activity`, typing is relayed; read cursors are neither kept nor relayed.
						...(this.config.activityEnabled ? { activity_per_minute: limits.activityBroadcastsPerUserMinute } : {}),
					},
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
		// Parsing is bounded CPU work with no storage; it comes first so an
		// activity notification can draw on its block lease. Every frame,
		// malformed ones included, is still charged before any other work.
		let parsed: ReturnType<typeof parseFrame> | undefined;
		let parseFailure: unknown;
		try {
			parsed = parseFrame(raw, {
				maxFrameBytes: this.config.limits.maxFrameBytes,
				maxJsonDepth: this.config.limits.maxJsonDepth,
				maxJsonNodes: this.config.limits.maxJsonNodes,
				maxRequestIdBytes: this.config.limits.maxRequestIdBytes,
			});
		} catch (error) {
			parseFailure = error;
		}
		// A server-wide spike limit, checked before any SQL. Over it, a request
		// gets retry_after and a notification is dropped; the socket stays open.
		const busy = this.takeServerFrame(nowMs());
		if (busy !== undefined) {
			if (parsed && parsed.request.id !== undefined) {
				this.fail(socket, parsed.request, { name: "retry_after", message: "Demo is busy; try again shortly", data: { retry_after: busy } });
			}
			return;
		}
		if (!this.chargeFrame(socket, attachment)) return;
		// The charge updated the attachment; handlers must not write back the copy read before it.
		const current = connectionAttachment(socket) ?? attachment;
		if (!parsed) {
			const error = parseFailure;
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
			await this.dispatch(socket, current, request);
		} catch (error) {
			const failure = errorToProtocol(error);
			this.fail(socket, request, failure);
			this.recordViolation(socket, failure);
		}
		if (!this.alarmKnown) await this.rescheduleAlarm();
	}

	/** Counts one frame against the server-wide minute; the seconds to wait when it is full. */
	private takeServerFrame(now: number): number | undefined {
		const frames = this.recentFrames;
		while (frames.length > 0 && frames[0] <= now - 60_000) frames.shift();
		if (frames.length >= this.config.limits.globalFramesPerMinute) return Math.max(1, Math.ceil((frames[0] + 60_000 - now) / 1_000));
		frames.push(now);
		return undefined;
	}

	/**
	 * Charges one incoming frame to the IP and daily frame budgets. A
	 * connection reserves `frameLease` frames at once and spends them from its
	 * attachment, so each frame carries a fraction of the reservation's SQL
	 * bookkeeping (SPEC section 7, durable block reservation). A block is never
	 * granted twice: it lives only in this connection's attachment, and an
	 * unspent one is burned when the connection closes or the UTC day ends.
	 */
	private chargeFrame(socket: WebSocketConnection, attachment: ConnectionAttachment): boolean {
		const now = nowMs();
		try {
			const latest = connectionAttachment(socket) ?? attachment;
			const day = new Date(now).toISOString().slice(0, 10);
			const lease = latest.frameLease?.day === day ? latest.frameLease.remaining : 0;
			if (lease > 0) {
				latest.frameLease = { day, remaining: lease - 1 };
			} else {
				const count = this.config.limits.frameLease;
				this.store.reserveFrames({ ipKey: attachment.ipKey, now, count });
				latest.frameLease = { day, remaining: count - 1 };
			}
			if (latest.frameLease.remaining === 0) delete latest.frameLease;
			writeAttachment(socket, latest);
			return true;
		} catch (error) {
			const failure = errorToProtocol(error);
			if (failure.message.includes("Daily frame budget")) {
				for (const peer of this.ctx.getWebSockets()) {
					const state = connectionAttachment(peer);
					if (state) this.closePolicy(peer, state, 1013, "Demo capacity reached; try after daily reset");
				}
			} else this.closePolicy(socket, connectionAttachment(socket) ?? attachment, 1013, failure.message);
			return false;
		}
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
			case "me":
				await this.handleMe(socket, attachment, request);
				return;
			case "activity":
				// Off by default (`ACTIVITY`): typing then gets the unsupported-method path.
				if (!this.config.activityEnabled) break;
				await this.handleActivity(socket, request);
				return;
			case "room_list":
				await this.handleRoomList(socket, attachment, request);
				return;
		}
		if (request.id === undefined) return;
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate first" } satisfies ProtocolError;
		throw { name: "unsupported", message: "Unsupported method" } satisfies ProtocolError;
	}

	private async handleAuth(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		// Authentication ceremonies are request/response exchanges. Ignore auth
		// notifications before reserving any attempt or changing attachment state.
		if (request.id === undefined && request.params.scheme === "webauthn") return;
		this.store.reserveAuthAttempt({ ipKey: attachment.ipKey, now: nowMs() });
		const params = request.params;
		const scheme = requiredString(params, "scheme");
		if (scheme === "guest") {
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
		const guest = attachment.tier === "anonymous" ? publicIdentity(attachment) : null;
		attachment.tier = "registered";
		attachment.userId = finished.identity.user_id;
		attachment.name = finished.identity.name;
		writeSessionAttachment(socket, attachment);
		this.reply(socket, request, { you: publicIdentity(attachment), token });
		if (guest) this.announceUser(socket, publicIdentity(attachment), guest);
		this.announceAuthenticated(socket, attachment);
		await this.rescheduleAlarm();
	}

	private assertRegisteredCapacity(socket: WebSocketConnection, userId: string): void {
		// A dropped socket lingers here until its close is processed; counting it
		// would refuse the reconnect that replaces it.
		const activeForUser = this.ctx.getWebSockets().filter(peer => {
			if (peer === socket || !openSocket(peer)) return false;
			const state = connectionAttachment(peer);
			return !!state && !state.closing && state.userId === userId;
		}).length;
		if (activeForUser >= this.config.limits.registeredConnectionsPerUser) throw { name: "retry_after", message: "Demo capacity reached", data: { retry_after: 60 } } satisfies ProtocolError;
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
		const guest = attachment.tier === "anonymous" ? publicIdentity(attachment) : null;
		attachment.tier = "registered";
		attachment.userId = identity.userId;
		attachment.name = identity.name;
		writeSessionAttachment(socket, attachment);
		this.reply(socket, request, { you: publicIdentity(attachment), token });
		if (guest) this.announceUser(socket, publicIdentity(attachment), guest);
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

	/** Drops expired session records from a bounded, ordered expiry index. */
	private async sweepSessions(now: number): Promise<void> {
		return this.withSessionLock(() => this.sweepSessionsLocked(now));
	}

	private async sweepSessionsLocked(now: number): Promise<void> {
		// Socket deadline alarms can be frequent. Probe the bounded expiry index
		// before reserving a full batch; this is the only maintenance work
		// performed until an expiry is actually due.
		const dueProbe = await this.store.withMeterAsync("maintenance", { reads: 1 }, () => this.ctx.storage.list<SessionExpiryEntry>({
			prefix: SESSION_EXPIRY_PREFIX,
			end: `${SESSION_EXPIRY_PREFIX}${Math.max(0, Math.trunc(now)).toString().padStart(16, "0")}\uffff`,
			limit: 1,
		}), now);
		if (dueProbe.size === 0) return;
		// Up to B index rows + B session reads; writes cover 2B expiry deletes.
		await this.store.withMeterAsync("maintenance", {
			reads: 2 * SESSION_CLEANUP_BATCH + 2,
			writes: 2 * SESSION_CLEANUP_BATCH,
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
			for (const room of this.store.listRooms(nowMs())) {
				this.noteRoom(room.room_id, true);
				this.send(socket, { method: "room", params: room });
			}
		} catch {
			// A session without its initial room boundaries cannot safely receive live records.
			this.closePolicy(socket, attachment, 1013, "History temporarily unavailable; reconnect later");
		}
	}

	private async handleHistory(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate before loading history" } satisfies ProtocolError;
		if (attachment.historyInFlight >= this.config.limits.concurrentHistoryPerConnection) throw { name: "retry_after", message: "History request already in progress", data: { retry_after: 1 } } satisfies ProtocolError;
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

	/**
	 * Profile update (section 3.3). Only registered users may change their
	 * name; `name: ""` removes it, so the user falls back to `user_id`. The demo
	 * keeps no avatars or profile ext, so `avatar` and `ext` are declined.
	 */
	private async handleMe(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity) throw { name: "denied", message: "Authenticate first" } satisfies ProtocolError;
		const name = optionalString(request.params, "name");
		optionalString(request.params, "avatar");
		objectParam(request.params, "ext", false);
		if (name === undefined) {
			this.reply(socket, request, { you: publicIdentity(attachment) });
			return;
		}
		if (attachment.tier !== "registered") {
			throw { name: "denied", message: "Only registered users may change their name" } satisfies ProtocolError;
		}
		await this.runMutation(async () => {
			const result = this.store.commitMutation({
				userId: identity.user_id, ipKey: attachment.ipKey,
				requestId: request.id, method: "me", now: nowMs(),
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
			// Section 3.3: `you` to the user's other connections, `new` to everyone
			// else, since every connection shares every room on this demo.
			if (!result.deduplicated && current) this.announceUser(socket, publicIdentity(current));
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
		// Server-owned fields are ignored on input (PROTOCOL.md §2).
		delete request.params.log_id;
		delete request.params.from;
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

	/**
	 * Typing (Appendix D.1), relayed to every other connection and never
	 * stored. Read cursors are dropped: the demo neither keeps nor relays them.
	 * At most `activityBroadcastsPerUserMinute` relays per user; past that the
	 * update is dropped and the sender gets one `@server` notice per minute.
	 */
	private async handleActivity(socket: WebSocketConnection, request: RequestFrame): Promise<void> {
		const attachment = connectionAttachment(socket);
		const identity = attachment ? publicIdentity(attachment) : null;
		if (!attachment || !identity) throw { name: "denied", message: "Authenticate first" } satisfies ProtocolError;
		const roomId = request.params.room_id;
		if (typeof roomId !== "string" || roomId.length === 0 || roomId.length > 64) throw { name: "invalid_params", message: "room_id must be a room" } satisfies ProtocolError;
		const typing = request.params.typing;
		if (typing !== undefined && (typeof typing !== "number" || !Number.isFinite(typing) || typing < 0)) {
			throw { name: "invalid_params", message: "typing must be a non-negative number of seconds" } satisfies ProtocolError;
		}
		if (request.id !== undefined) this.reply(socket, request, {});
		if (typing === undefined || !this.roomExists(roomId)) return;
		const now = nowMs();
		const limit = this.config.limits.activityBroadcastsPerUserMinute;
		if (!this.takeThrottle(socket, identity.user_id, "activity", limit, now)) {
			await this.noticeThrottled(socket, identity.user_id, "activity", roomId, now,
				`Typing updates are limited to ${limit} per minute, so others may not see you typing for a moment.`);
			return;
		}
		const seconds = Math.min(Math.floor(typing), this.config.limits.activityMaxTypingSeconds);
		const frame = { method: "activity", params: { room_id: roomId, from: identity, typing: seconds } };
		this.broadcast(frame, undefined, socket);
	}

	/**
	 * Rooms for discovery (Appendix C): the top-level rooms, or one room's
	 * threads. Every room is visible and joined, so `members` is everyone
	 * connected now, capped; the list is the same for every room.
	 */
	private async handleRoomList(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity) throw { name: "denied", message: "Authenticate before listing rooms" } satisfies ProtocolError;
		const parent = optionalString(request.params, "parent_room_id");
		const now = nowMs();
		const retry = this.throttleRetry(identity.user_id, "room_list", this.config.limits.roomListRequestsPerUserMinute, now);
		if (retry !== undefined) throw { name: "retry_after", message: "Room listing limited", data: { retry_after: retry } } satisfies ProtocolError;
		const rooms = this.store.listRooms(now);
		this.takeThrottle(socket, identity.user_id, "room_list", Number.MAX_SAFE_INTEGER, now);
		for (const room of rooms) this.noteRoom(room.room_id, true);
		if (parent !== undefined && !rooms.some((room) => room.room_id === parent)) throw { name: "invalid_params", message: "Unknown parent_room_id" } satisfies ProtocolError;
		const members = this.connectedMembers();
		this.reply(socket, request, {
			rooms: rooms
				.filter((room) => (parent === undefined ? room.parent_room_id === undefined : room.parent_room_id === parent))
				.map((room) => ({ ...room, members })),
		});
	}

	/** Everyone authenticated and connected, one entry per user, capped. */
	private connectedMembers(): Array<{ user_id: string; name?: string }> {
		const members = new Map<string, { user_id: string; name?: string }>();
		for (const peer of this.ctx.getWebSockets()) {
			const state = connectionAttachment(peer as WebSocketConnection);
			const identity = state && !state.closing ? publicIdentity(state) : null;
			if (!identity || members.has(identity.user_id)) continue;
			members.set(identity.user_id, identity);
			if (members.size >= this.config.limits.roomListMembers) break;
		}
		return [...members.values()];
	}

	/** Sends a profile change (section 3.3): `you` to the user's other connections, `new` (and `old`) to the rest. */
	private announceUser(origin: WebSocketConnection, identity: { user_id: string; name?: string } | null, old?: { user_id: string; name?: string } | null): void {
		if (!identity) return;
		for (const peer of this.ctx.getWebSockets()) {
			const socket = peer as WebSocketConnection;
			if (socket === origin) continue;
			const state = connectionAttachment(socket);
			const own = state?.userId === identity.user_id;
			this.broadcast({ method: "user", params: own ? { you: identity } : { new: identity, ...(old ? { old } : {}) } }, socket);
		}
	}

	private noteRoom(roomId: string, exists: boolean): void {
		this.knownRooms.delete(roomId);
		// The rooms table is capped; unknown IDs are bounded by the same size.
		if (this.knownRooms.size >= 2 * (this.config.limits.threadLimit + 1)) this.knownRooms.delete(this.knownRooms.keys().next().value!);
		this.knownRooms.set(roomId, exists);
	}

	/** Whether a room exists, from the cache or one bounded lookup. */
	private roomExists(roomId: string): boolean {
		const known = this.knownRooms.get(roomId);
		if (known !== undefined) return known;
		const exists = this.store.getRoom(roomId, nowMs()) !== null;
		this.noteRoom(roomId, exists);
		return exists;
	}

	/** Events of one type from a user's connections within the window. */
	private throttleEvents(userId: string, type: ThrottledType, now: number): number[] {
		const events: number[] = [];
		for (const peer of this.ctx.getWebSockets()) {
			const state = connectionAttachment(peer as WebSocketConnection);
			if (state?.userId !== userId) continue;
			for (const at of state.throttles?.[type] ?? []) if (at > now - THROTTLE_WINDOW_MS) events.push(at);
		}
		return events.sort((a, b) => a - b);
	}

	/** Seconds until the user may send one more of this type, or undefined when they may now. */
	private throttleRetry(userId: string, type: ThrottledType, limit: number, now: number): number | undefined {
		const events = this.throttleEvents(userId, type, now);
		if (events.length < limit) return undefined;
		return Math.max(1, Math.ceil((events[events.length - limit] + THROTTLE_WINDOW_MS - now) / 1_000));
	}

	/** Counts one event against the user's per-type limit; false when the limit is reached. */
	private takeThrottle(socket: WebSocketConnection, userId: string, type: ThrottledType, limit: number, now: number): boolean {
		if (this.throttleRetry(userId, type, limit, now) !== undefined) return false;
		const state = connectionAttachment(socket);
		if (!state) return false;
		const events = (state.throttles?.[type] ?? []).filter((at) => at > now - THROTTLE_WINDOW_MS);
		state.throttles = { ...state.throttles, [type]: [...events, now].slice(-MAX_TYPE_THROTTLE_PER_MINUTE) };
		writeAttachment(socket, state);
		return true;
	}

	/**
	 * Tells a throttled sender, once per window per user, with a `@server`
	 * message (Appendix J.1) in the room they were active in. It goes to that
	 * connection only and is never logged; its log_id still comes from the
	 * server's sequence so no record can collide with it.
	 */
	private async noticeThrottled(socket: WebSocketConnection, userId: string, type: ThrottledType, roomId: string, now: number, text: string): Promise<void> {
		for (const peer of this.ctx.getWebSockets()) {
			const state = connectionAttachment(peer as WebSocketConnection);
			if (state?.userId === userId && (state.notices?.[type] ?? 0) > now - THROTTLE_WINDOW_MS) return;
		}
		const state = connectionAttachment(socket);
		if (!state) return;
		state.notices = { ...state.notices, [type]: now };
		writeAttachment(socket, state);
		let logId: string;
		try {
			logId = this.store.allocateUnloggedLogId(now);
		} catch {
			return; // A notice is a courtesy; without capacity the update is still dropped.
		}
		this.broadcast({
			method: "message",
			params: { message_id: logId, log_id: logId, room_id: roomId, from: { ...SERVER_IDENTITY }, body: { text, format: "plain" } },
		}, socket);
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
		if (record.method === "room" && typeof record.params.room_id === "string") this.noteRoom(record.params.room_id, true);
		this.broadcast({ method: record.method, params: record.params });
	}

	/** Sends to every authenticated connection, or only to `only`, or to all but `except`. */
	private broadcast(value: unknown, only?: WebSocketConnection, except?: WebSocketConnection): void {
		for (const ws of this.ctx.getWebSockets()) {
			const socket = ws as WebSocketConnection;
			if ((only && socket !== only) || socket === except) continue;
			const attachment = connectionAttachment(socket);
			if (!attachment || attachment.closing || (attachment.tier !== "anonymous" && attachment.tier !== "registered")) continue;
			if (!this.send(socket, value)) {
				attachment.closing = true;
				writeAttachment(socket, attachment);
				try { socket.close(1011, "Delivery failed; reconnect to recover"); } catch { /* closed */ }
			}
		}
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
