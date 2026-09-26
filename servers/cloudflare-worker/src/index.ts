import { DurableObject } from "cloudflare:workers";
import { AuthError, AuthTooLargeError, WebAuthnService, type ChallengeRecord, type CredentialRepository } from "./auth";
import { isAllowedOrigin, loadConfig, type RuntimeConfig } from "./config";
import { ACCOUNT_USAGE_POLICY, ADMISSION_BUDGET, MAX_FRAME_LEASE, MAX_THREAD_LIMIT, MAX_TYPE_THROTTLE_PER_MINUTE } from "./budget";
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
import { DEFAULT_JOINED_ROOMS, ROOM_ID, Store, StoreError, type Broadcast, type RoomRecord, type StoreConfig, type StoreMutationInput } from "./store";

const OBJECT_NAME = "public-demo-v1";
const INTERNAL_IP_HEADER = "X-Apron-Trusted-IP-Key";
const ATTACHMENT_VERSION = 1;
/** Key prefix for passkey session records in the object's key-value storage. */
const SESSION_KEY_PREFIX = "session:";
/** Ordered, advisory expiry entries. The session record remains authoritative. */
const SESSION_EXPIRY_PREFIX = "session-expiry:";
const SESSION_CLEANUP_BATCH = 16;
/**
 * How often an alarm sweeps expired sessions. Every connection wakes the alarm
 * at its auth deadline, and the probe is KV work charged at its full bound, so
 * it runs at most this often; a resume rejects an expired session on its own.
 */
const SESSION_SWEEP_INTERVAL_MS = 60 * 60_000;
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
	/** The WebSocket URL this connection reached, for instructions that name the server (`/invite-bot`). */
	endpoint?: string;
	challenge?: ChallengeRecord;
	authDeadline: number;
	pendingFrames: number;
	pendingBytes: number;
	policyViolations: number[];
	historyInFlight: number;
	frameTimes: number[];
	/** Per-type throttle events from this connection, oldest first (budget.ts). */
	throttles?: Partial<Record<ThrottledType, number[]>>;
	/** When this connection last got a `@private` throttle notice, per type. */
	notices?: Partial<Record<ThrottledType, number>>;
	/** Frames this connection has already reserved and not yet spent, for one UTC day. */
	frameLease?: { day: string; remaining: number };
	/**
	 * The rooms this connection's user has joined (§4.3.2), which it receives
	 * deliveries for. Set at authentication and kept equal across the user's
	 * connections; a registered user's are also stored in the `memberships` table.
	 */
	rooms?: string[];
	/**
	 * Whether a `filter: "joined"` listing has been answered since
	 * authentication. The first one is not throttled: it is how a client
	 * learns its rooms.
	 */
	listedJoined?: boolean;
	closing?: boolean;
}

/** Message types with their own per-user rate (budget.ts). */
type ThrottledType = "activity" | "room_list";
const THROTTLED_TYPES: readonly ThrottledType[] = ["activity", "room_list"];
const THROTTLE_WINDOW_MS = 60_000;
/** The system identity for notices to one user only, never logged (Appendix A.1). */
const PRIVATE_IDENTITY = { user_id: "@private", name: "System message to you" } as const;
/**
 * The liveness ping clients send every `server.ping` seconds, byte for byte,
 * and its answer (§1). The runtime answers it without waking the object.
 */
const PING_REQUEST = '{"method":"ping"}';
const PING_RESPONSE = '{"method":"pong"}';
/** Joined room IDs a connection attachment may carry: every room, with slack for removals in flight. */
const MAX_ATTACHED_ROOMS = 2 * (MAX_THREAD_LIMIT + 1);
/**
 * The commands this server provides (§4.8), as `/help` lists them to those
 * who may run them: `everyone`, or `owners`, registered users other than bots.
 */
const COMMANDS: ReadonlyArray<{ name: string; usage: string; help: string; audience: "everyone" | "owners" }> = [
	{ name: "help", usage: "/help", help: "list the commands you can use here", audience: "everyone" },
	{ name: "invite-bot", usage: "/invite-bot", help: "get a sign-in token for your bot; a new one replaces the last", audience: "owners" },
];
/** Why a guest's post, reaction, join, leave, or room change is denied while guests only read. */
const GUEST_READ_ONLY = "Guests can only read here; sign in with a passkey to post or join rooms";
/**
 * A registered user's bot is `bot_` plus the owner's `user_id`. Guests are
 * `guest_<n>` and registered users `u_…`, so the prefix names bots alone.
 */
const BOT_ID_PREFIX = "bot_";
/** Bot tokens start with this, so `auth` tells them from passkey session tokens without a storage read. */
const BOT_TOKEN_PREFIX = "apron_bot_";
/** Key prefix for bot tokens in key-value storage, by the token's SHA-256 like sessions. */
const BOT_TOKEN_KEY_PREFIX = "bot-token:";
/** Key prefix for each bot's current token key, so a new `/invite-bot` revokes the last token. */
const BOT_KEY_PREFIX = "bot:";
/** The protocol a bot's instructions point it at (`/invite-bot`). */
const PROTOCOL_URL = "https://github.com/shazow/apron/blob/main/PROTOCOL.md";

/**
 * A bearer session minted by a verified passkey login (protocol §4.9,
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

/**
 * A bot's bearer token (`/invite-bot`), stored under its SHA-256. Unlike a
 * passkey session it is bound to no origin, since bots are not browsers, and
 * does not expire: the owner's next `/invite-bot` replaces it.
 */
interface StoredBotToken {
	v: 1;
	botId: string;
	ownerId: string;
}

/** A bot's current token, by key, so the next invite can revoke it. */
interface StoredBot {
	v: 1;
	tokenKey: string;
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

async function sha256Hex(token: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sessionKey(token: string): Promise<string> {
	return SESSION_KEY_PREFIX + await sha256Hex(token);
}

/** Longest connection endpoint an attachment keeps. */
const MAX_ENDPOINT_CHARS = 256;

/** The WebSocket URL a request reached, `ws(s)://host/path` without its query; undefined when too long. */
function endpointOf(request: Request): string | undefined {
	const url = new URL(request.url);
	const endpoint = `${url.protocol === "http:" ? "ws:" : "wss:"}//${url.host}${url.pathname}`;
	return endpoint.length <= MAX_ENDPOINT_CHARS ? endpoint : undefined;
}

function isBot(userId: string | undefined): boolean {
	return userId?.startsWith(BOT_ID_PREFIX) === true;
}

/** "Bot of <owner>", cut to the name limits by whole code points. */
function botName(owner: string, limits: { maxNameCodePoints: number; maxNameBytes: number }): string {
	const points = [...`Bot of ${owner}`].slice(0, limits.maxNameCodePoints);
	while (utf8Bytes(points.join("")) > limits.maxNameBytes) points.pop();
	return points.join("");
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
			...(typeof attachment.endpoint === "string" && attachment.endpoint.length <= MAX_ENDPOINT_CHARS ? { endpoint: attachment.endpoint } : {}),
			...(challenge ? { challenge } : {}),
			...(Array.isArray(attachment.rooms) ? {
				rooms: attachment.rooms.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64).slice(0, MAX_ATTACHED_ROOMS),
			} : {}),
			...(attachment.listedJoined ? { listedJoined: true } : {}),
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

/** A user object as this server sends it (§3.3): `user_id` and `name`. */
type PublicUser = { user_id: string; name?: string };

/** A room in a listing, with `members` when asked for (§4.3.1). */
type ListedRoom = RoomRecord & { members?: Array<{ user_id: string }> };

/** A `room_list` result (§4.3.1). */
interface ListingResult {
	joined?: ListedRoom[];
	not_joined?: ListedRoom[];
	users?: PublicUser[];
}

/** User objects once each, in `user_id` order. */
function sortedUsers(users: Iterable<PublicUser>): PublicUser[] {
	return [...users].sort((a, b) => a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0);
}

/** A `room_update` notification (§4.3.3) with one field. */
function roomUpdate(field: "joined" | "updated" | "left", ...records: unknown[]): Record<string, unknown> {
	return { method: "room_update", params: { [field]: records } };
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
	/** When the next alarm may sweep sessions; in memory, so a wake sweeps once. */
	private nextSessionSweepAt = 0;
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
	/**
	 * Guest numbers reserved durably and not yet handed out: the next one, and
	 * one past the last. Both start at zero, so the first guest after a start
	 * or wake reserves a fresh block rather than reusing one it cannot see.
	 */
	private guestNext = 0;
	private guestLimit = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.runtimeEnv = env;
		this.config = loadConfig(env);
		this.store = new Store(ctx as unknown as ConstructorParameters<typeof Store>[0], asStoreConfig(this.config));
		this.webAuthn = new WebAuthnService(this.config);
		// Answered by the runtime without waking the object or reaching
		// webSocketMessage; the time of the last answer tells a live peer from
		// one that vanished without a close frame (see isStale).
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_REQUEST, PING_RESPONSE));
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
			// A vanished peer's socket still takes a slot until the runtime lets go
			// of it, but it must not lock its own IP out of reconnecting.
			const now = nowMs();
			this.closeStale(now);
			const peers = sockets.filter(socket => !this.isStale(socket, now)).map(socket => connectionAttachment(socket)).filter(peer => peer?.ipKey === ipKey);
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
		const endpoint = endpointOf(request);
		const attachment: ConnectionAttachment = {
			v: 1,
			connId: randomId("c"),
			ipKey,
			tier: "pending",
			...(origin ? { origin } : {}),
			...(endpoint ? { endpoint } : {}),
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
		// Where guests only read, a welcome says so before any auth (§3.2,
		// Appendix B): to this connection only, with no room_id, since the
		// client knows no rooms yet.
		if (!this.config.guestPosting) this.send(server, this.readOnlyWelcome(origin));
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
		if (now >= this.nextSessionSweepAt) {
			try {
				// A full batch may have left more behind; sweep again on the next alarm.
				const full = await this.sweepSessions(now);
				this.nextSessionSweepAt = full ? 0 : now + SESSION_SWEEP_INTERVAL_MS;
			} catch { /* retried on the next alarm */ }
		}
		let result: ReturnType<Store["runCleanup"]> | undefined;
		try {
			result = this.store.runCleanup(now);
		} catch {
			// A metered maintenance failure is deferred. Do not spin an alarm loop.
			// The floor may already be durable even if a physical deletion failed,
			// so send every room's current record below.
		}
		// Committed removals need no store access; tell their members before any
		// listing that could fail on an exhausted budget.
		const removed = result?.removed_rooms ?? [];
		for (const roomId of removed) this.noteRoom(roomId, false);
		if (removed.length) this.removeRooms(removed);
		if (!result || result.history_floor !== result.previous_floor) {
			try {
				// Only rooms whose history_log_id moved need a new record.
				const rooms = this.store.listRooms(nowMs(), {
					maintenance: true,
					...(result ? { changedSinceFloor: Number(result.previous_floor) } : {}),
				});
				this.announceUpdated(rooms);
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
				protocol: 6,
				name: "apron-cloudflare-demo/6",
				caps: ["history", "edit", "rooms", "reactions", "command", ...(this.config.activityEnabled ? ["activity"] : [])],
				// Passkeys and their session tokens only where passkeys are offered;
				// bot tokens (`/invite-bot`) from anywhere, since bots are not browsers.
				auth: origin !== null && this.config.rpOrigins.includes(origin) ? ["webauthn", "token", "guest"] : ["token", "guest"],
				// Answered by the runtime without waking the object (see PING_REQUEST).
				ping: limits.pingSeconds,
				ext: {
					demo: {
						retention_seconds: limits.retentionSeconds,
						cleanup_seconds: limits.cleanupSeconds,
						max_frame_bytes: limits.maxFrameBytes,
						max_message_text_bytes: limits.maxTextBytes,
						max_snapshot_bytes: limits.maxSnapshotBytes,
						guest_posts_per_minute: limits.anonymousPostsPerMinute,
						registered_posts_per_minute: limits.registeredPostsPerMinute,
						// `false`: guests only read; posting, reacting, and room changes need a sign-in.
						guest_posting: this.config.guestPosting,
						server_frames_per_minute: limits.globalFramesPerMinute,
						room_list_per_minute: limits.roomListRequestsPerUserMinute,
						// Registered members listed per room in `members`; connected ones are always listed.
						room_list_members: limits.roomListMembers,
						// `read_message_id` in `activity` is dropped: no read cursors are kept.
						read_cursors: false,
						// With `activity`, typing is relayed; read cursors are neither kept nor relayed.
						...(this.config.activityEnabled ? { activity_per_minute: limits.activityBroadcastsPerUserMinute } : {}),
					},
				},
			},
		};
	}

	/** The `@private` welcome for a server whose guests only read, worded for what this origin can sign in with. */
	private readOnlyWelcome(origin: string | null): Record<string, unknown> {
		const passkeys = origin !== null && this.config.rpOrigins.includes(origin);
		const text = passkeys
			? "Guests can read. *Sign in with passkey* to participate."
			: "Guests can read. *Sign in with passkey* on the demo's own site, or use a bot token from `/invite-bot` there, to participate.";
		return { method: "message", params: { from: { ...PRIVATE_IDENTITY }, body: { text, format: "markdown" } } };
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
			case "room_set":
				await this.handleRoomSet(socket, attachment, request);
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
			case "command":
				await this.handleCommand(socket, attachment, request);
				return;
			case "ping":
				// The exact ping bytes are answered by the runtime; a ping with other
				// spacing reaches here and is answered too, before auth as well (§1).
				if (request.id !== undefined) break;
				this.send(socket, JSON.parse(PING_RESPONSE));
				return;
		}
		if (request.id === undefined) return;
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate first" } satisfies ProtocolError;
		throw { name: "unsupported", message: "Unsupported method" } satisfies ProtocolError;
	}

	/**
	 * The next guest number. Numbers come from the in-memory block; an empty
	 * block (always so after a start or wake) first reserves the next
	 * `guestNumberBlock` numbers with one durable write. There is no await
	 * between reading and advancing `guestNext`, and the Store call is
	 * synchronous, so concurrent auths on other connections cannot both take
	 * a number or both reserve a block. A failed reservation (an exhausted
	 * budget) leaves the block empty and fails the auth.
	 */
	private nextGuestNumber(): number {
		if (this.guestNext >= this.guestLimit) {
			const block = this.store.reserveGuestNumbers(this.config.limits.guestNumberBlock, nowMs());
			this.guestNext = block.first;
			this.guestLimit = block.limit;
		}
		return this.guestNext++;
	}

	private async handleAuth(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		// Authentication ceremonies are request/response exchanges. Ignore auth
		// notifications before reserving any attempt or changing attachment state.
		if (request.id === undefined && request.params.scheme === "webauthn") return;
		// A guest auth on an authenticated connection changes nothing: answer it
		// without charging an attempt.
		if (request.params.scheme === "guest" && (attachment.tier === "anonymous" || attachment.tier === "registered")) {
			this.reply(socket, request, { you: publicIdentity(attachment) });
			return;
		}
		this.store.reserveAuthAttempt({ ipKey: attachment.ipKey, now: nowMs() });
		const params = request.params;
		const scheme = requiredString(params, "scheme");
		if (scheme === "guest") {
			// A requested `name` or `user_id` is not honored: guests are
			// `guest_<n>` from a server-wide counter, never reissued, with a
			// generated name they keep (§3.2 lets the server assign identity).
			const number = this.nextGuestNumber();
			attachment.tier = "anonymous";
			attachment.userId = `guest_${number}`;
			attachment.name = `Guest ${number}`.slice(0, Math.min(this.config.limits.maxNameCodePoints, this.config.limits.maxNameBytes));
			// A new guest has joined the default room (§3.4).
			attachment.rooms = [...DEFAULT_JOINED_ROOMS];
			delete attachment.listedJoined;
			writeAttachment(socket, attachment);
			this.reply(socket, request, { you: publicIdentity(attachment) });
			await this.rescheduleAlarm();
			return;
		}
		if (scheme === "token") {
			const token = requiredString(params, "token");
			if (token.startsWith(BOT_TOKEN_PREFIX)) await this.handleBotToken(socket, attachment, request, token);
			else await this.handleTokenResume(socket, attachment, request);
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
				// A guest registering on its connection keeps the rooms it had joined.
				const identity = this.store.registerIdentity({ ...input, ...(attachment.tier === "anonymous" && attachment.rooms ? { rooms: attachment.rooms } : {}) });
				// Each starting room's logged join goes to the room's members, this
				// connection among them, before anything else can commit (§4.3.2).
				for (const record of identity.broadcasts) this.broadcastRecord(record);
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
		const guestRooms = attachment.rooms ?? [];
		attachment.tier = "registered";
		attachment.userId = finished.identity.user_id;
		attachment.name = finished.identity.name;
		attachment.rooms = this.registeredRooms(socket, finished.identity.user_id);
		delete attachment.listedJoined;
		writeSessionAttachment(socket, attachment);
		this.reply(socket, request, { you: publicIdentity(attachment), token });
		if (guest) this.announceUser(socket, publicIdentity(attachment), [...guestRooms, ...attachment.rooms], guest);
		await this.rescheduleAlarm();
	}

	/**
	 * A registered user's joined rooms for a connection it is authenticating:
	 * those of its other live connections, which are kept current, or else the
	 * ones stored with the identity.
	 */
	private registeredRooms(socket: WebSocketConnection, userId: string): string[] {
		return this.liveRoomsOf(userId, socket) ?? this.store.getIdentity(userId)?.rooms ?? [...DEFAULT_JOINED_ROOMS];
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
	 * unexpired. A resume once less than half its lifetime remains renews it for
	 * a full lifetime; earlier resumes leave it as is, since renewal is three KV
	 * writes charged at their bound on every reload, tab and reconnect. The
	 * token is not rotated, so several tabs may share one persisted token.
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
		const lifetimeMs = this.config.limits.sessionTtlSeconds * 1_000;
		const renewed = { ...session, expiresMs: now + lifetimeMs };
		if (session.expiresMs - now < lifetimeMs / 2) {
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
		}
		if (connectionAttachment(socket)?.closing || !openSocket(socket)) return;
		const guest = attachment.tier === "anonymous" ? publicIdentity(attachment) : null;
		const guestRooms = attachment.rooms ?? [];
		attachment.tier = "registered";
		attachment.userId = identity.userId;
		attachment.name = identity.name;
		attachment.rooms = this.liveRoomsOf(identity.userId, socket) ?? identity.rooms;
		delete attachment.listedJoined;
		writeSessionAttachment(socket, attachment);
		this.reply(socket, request, { you: publicIdentity(attachment), token });
		if (guest) this.announceUser(socket, publicIdentity(attachment), [...guestRooms, ...attachment.rooms], guest);
		await this.rescheduleAlarm();
	}

	/**
	 * Signs a bot in with the token its owner got from `/invite-bot`, through
	 * the `token` scheme (§3.2). Bots are not browsers, so unlike a passkey
	 * session the token is taken from any origin, or none.
	 */
	private async handleBotToken(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, token: string): Promise<void> {
		return this.withSessionLock(async () => {
			if (attachment.tier === "registered") throw { name: "denied", message: "Identity switching requires reconnect" } satisfies ProtocolError;
			if (token.length > MAX_SESSION_TOKEN_CHARS) throw { name: "invalid_params", message: "token is too long" } satisfies ProtocolError;
			const key = BOT_TOKEN_KEY_PREFIX + await sha256Hex(token);
			const stored = await this.store.withMeterAsync("foreground", { reads: 1 }, () => this.ctx.storage.get<StoredBotToken>(key));
			const invalid = { name: "denied", message: "Bot token is not valid; its owner can get a new one with /invite-bot" } satisfies ProtocolError;
			if (!stored || stored.v !== 1 || !isBot(stored.botId)) throw invalid;
			const identity = this.store.getIdentity(stored.botId);
			if (!identity) throw invalid;
			if (connectionAttachment(socket)?.closing || !openSocket(socket)) return;
			this.assertRegisteredCapacity(socket, identity.userId);
			const guest = attachment.tier === "anonymous" ? publicIdentity(attachment) : null;
			const guestRooms = attachment.rooms ?? [];
			attachment.tier = "registered";
			attachment.userId = identity.userId;
			attachment.name = identity.name;
			attachment.rooms = this.liveRoomsOf(identity.userId, socket) ?? identity.rooms;
			delete attachment.listedJoined;
			writeSessionAttachment(socket, attachment);
			this.reply(socket, request, { you: publicIdentity(attachment) });
			if (guest) this.announceUser(socket, publicIdentity(attachment), [...guestRooms, ...attachment.rooms], guest);
			await this.rescheduleAlarm();
		});
	}

	/**
	 * Mints a bot's token and revokes the one before it. The token is stored
	 * only as its SHA-256; the plaintext goes to the owner once.
	 */
	private async issueBotToken(botId: string, ownerId: string): Promise<string> {
		return this.withSessionLock(async () => {
			const token = BOT_TOKEN_PREFIX + bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
			const key = BOT_TOKEN_KEY_PREFIX + await sha256Hex(token);
			await this.store.withMeterAsync("foreground", { reads: 1, writes: 3 }, async () => {
				const previous = await this.ctx.storage.get<StoredBot>(BOT_KEY_PREFIX + botId);
				// Revoke first: a failure between the writes leaves no token, never two.
				if (previous?.v === 1 && typeof previous.tokenKey === "string") await this.ctx.storage.delete(previous.tokenKey);
				await this.ctx.storage.put<StoredBotToken>(key, { v: 1, botId, ownerId });
				await this.ctx.storage.put<StoredBot>(BOT_KEY_PREFIX + botId, { v: 1, tokenKey: key });
			});
			return token;
		});
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
	/** Whether it processed a full batch, so more may be due. */
	private async sweepSessions(now: number): Promise<boolean> {
		return this.withSessionLock(() => this.sweepSessionsLocked(now));
	}

	private async sweepSessionsLocked(now: number): Promise<boolean> {
		// Socket deadline alarms can be frequent. Probe the bounded expiry index
		// before reserving a full batch; this is the only maintenance work
		// performed until an expiry is actually due.
		const dueProbe = await this.store.withMeterAsync("maintenance", { reads: 1 }, () => this.ctx.storage.list<SessionExpiryEntry>({
			prefix: SESSION_EXPIRY_PREFIX,
			end: `${SESSION_EXPIRY_PREFIX}${Math.max(0, Math.trunc(now)).toString().padStart(16, "0")}\uffff`,
			limit: 1,
		}), now);
		if (dueProbe.size === 0) return false;
		// Up to B index rows + B session reads; writes cover 2B expiry deletes.
		return await this.store.withMeterAsync("maintenance", {
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
			return indexed.size >= SESSION_CLEANUP_BATCH;
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

	private async handleHistory(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate before loading history" } satisfies ProtocolError;
		if (attachment.historyInFlight >= this.config.limits.concurrentHistoryPerConnection) throw { name: "retry_after", message: "History request already in progress", data: { retry_after: 1 } } satisfies ProtocolError;
		const params = request.params;
		// Without room_id, history pages the default room (§4.1). Every room is
		// visible, so any room's history may be read without joining it.
		const roomId = optionalString(params, "room_id");
		const after = asDecimalId(params.after, "after");
		const before = asDecimalId(params.before, "before");
		const limit = positiveIntParam(params, "limit");
		attachment.historyInFlight += 1;
		writeAttachment(socket, attachment);
		try {
			const page = this.store.history({
				...(roomId !== undefined ? { roomId } : {}),
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
	 * Profile update (section 3.3): a given field replaces its value, an
	 * omitted one is unchanged, and an empty one removes it. Only registered
	 * users may change their name; `name: ""` removes it, so the user falls
	 * back to `user_id`. The demo keeps no avatars or profile ext, so `avatar`
	 * and `ext` are type-checked and declined.
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
		if (isBot(identity.user_id)) {
			throw { name: "denied", message: "A bot is named after its owner, who can rename it with /invite-bot" } satisfies ProtocolError;
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
			if (!current) return;
			// A removed name is announced as its empty value (§3.3).
			const you = current.name ? publicIdentity(current) : { user_id: identity.user_id, name: "" };
			this.reply(socket, request, { you });
			// Section 3.3: `you` to the user's other connections, `new` to those who share a room with the user.
			if (!result.deduplicated) this.announceUser(socket, you, current.rooms ?? []);
		});
	}

	/**
	 * Guests only read unless `GUEST_POSTING` is on: posting, reacting,
	 * joining, leaving, and room changes are denied by policy (§3.5, §4.3.2).
	 * Listing rooms and reading history stay open.
	 */
	private assertMayWrite(attachment: ConnectionAttachment): void {
		if (attachment.tier === "anonymous" && !this.config.guestPosting) throw { name: "denied", message: GUEST_READ_ONLY } satisfies ProtocolError;
	}

	/** Shared path for logged mutations: dedup, quotas, commit, reply, broadcast. */
	private async commitAndBroadcast(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, method: "message" | "reactions", action: string): Promise<void> {
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
			// A deduplicated retry carries no records and is never rebroadcast.
			// The broadcast comes before the result on the sender's connection (§1).
			for (const record of result.broadcasts) this.broadcastRecord(record);
			this.reply(socket, request, result.result);
		});
	}

	private async handleMessage(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate before posting" } satisfies ProtocolError;
		this.assertMayWrite(attachment);
		// Without room_id a message goes to the default room (§3.5). Posting does
		// not require joining; a poster who has not joined gets only the result.
		optionalString(request.params, "room_id");
		// Server-owned fields are ignored on input (PROTOCOL.md §2).
		delete request.params.log_id;
		delete request.params.from;
		const messageId = optionalString(request.params, "message_id");
		if (messageId === undefined && request.params.body === undefined) throw { name: "invalid_params", message: "Missing body" } satisfies ProtocolError;
		if (request.params.body !== undefined) objectParam(request.params, "body");
		await this.commitAndBroadcast(socket, attachment, request, "message", "posting");
	}

	private async handleReactions(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (identityOf(attachment)) this.assertMayWrite(attachment);
		await this.commitAndBroadcast(socket, attachment, request, "reactions", "reacting");
	}

	/**
	 * `room_set` (§4.3.4): creates a thread under `general`, which joins its
	 * creator, or replaces a thread's client fields. Creating sends the
	 * creator's connections `room_update` `joined` with the room's members,
	 * then a registered creator's logged membership, and the parent's other
	 * members `updated`. A save sends `updated` to the members of the room and
	 * of its parent, and to the saver. Both come before the result (§1).
	 */
	private async handleRoomSet(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity) throw { name: "denied", message: "Authenticate before changing rooms" } satisfies ProtocolError;
		this.assertMayWrite(attachment);
		await this.runMutation(async () => {
			const result = this.store.mutate({
				userId: identity.user_id, tier: identity.tier, ipKey: attachment.ipKey,
				requestId: request.id, method: "room_set", now: nowMs(), params: request.params, identity,
			});
			const room = result.room;
			if (room && !result.deduplicated) {
				this.noteRoom(room.room_id, true);
				const scope = [room.room_id, ...(room.parent_room_id !== undefined ? [room.parent_room_id] : [])];
				if (result.created) {
					this.setRooms(identity.user_id, [...(this.liveRoomsOf(identity.user_id) ?? []), room.room_id]);
					// A new room's only member is its creator: no storage to read.
					const creator = { user_id: identity.user_id, ...(identity.name ? { name: identity.name } : {}) };
					this.sendToUser(identity.user_id, this.joinedUpdate(room, [creator]));
					if (result.membership) this.broadcastRecord(result.membership);
					this.deliver(roomUpdate("updated", room), scope, (state) => state.userId !== identity.user_id);
				} else {
					this.deliver(roomUpdate("updated", room), scope, (state) => state.userId !== identity.user_id);
					this.sendToUser(identity.user_id, roomUpdate("updated", room));
				}
			}
			this.reply(socket, request, result.result);
		});
	}

	/**
	 * `room_join` (§4.3.2): every connection of the user receives the room's
	 * deliveries from now on. A registered user's join is stored and logged:
	 * its membership goes to the room's members, the joiner's connections
	 * included. Then the user's connections get `room_update` `joined` with
	 * the room's members, and then the result. A guest's join lives in its
	 * connection and is not logged. Joining a room already joined logs
	 * nothing and re-sends `joined` to this connection only.
	 */
	private async handleRoomJoin(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity) throw { name: "denied", message: "Authenticate before joining rooms" } satisfies ProtocolError;
		this.assertMayWrite(attachment);
		const roomId = requiredString(request.params, "room_id");
		const known = this.store.getRoom(roomId, nowMs());
		this.noteRoom(roomId, known !== null);
		if (!known) throw { name: "invalid_params", message: "Unknown room" } satisfies ProtocolError;
		// The members before the join, read before anything commits.
		const before = this.membersOf([roomId]);
		const joiner = { user_id: identity.user_id, ...(identity.name ? { name: identity.name } : {}) };
		const current = attachment.rooms ?? [];
		if (current.includes(roomId)) {
			this.send(socket, this.joinedUpdate(known, before.get(roomId), joiner));
			this.reply(socket, request, {});
			return;
		}
		if (identity.tier !== "registered") {
			this.setRooms(identity.user_id, [...current, roomId]);
			this.sendToUser(identity.user_id, this.joinedUpdate(known, before.get(roomId), joiner));
			this.reply(socket, request, {});
			return;
		}
		await this.runMutation(async () => {
			const change = this.store.changeMembership({ userId: identity.user_id, ipKey: attachment.ipKey, roomId, join: true, now: nowMs() });
			this.setRooms(identity.user_id, change.rooms);
			if (change.membership) this.broadcastRecord(change.membership);
			this.sendToUser(identity.user_id, this.joinedUpdate(change.room ?? known, before.get(roomId), joiner));
			this.reply(socket, request, {});
		});
	}

	/**
	 * `room_leave` (§4.3.2): a registered user's leave is stored and logged,
	 * and its membership goes to the room's members, the leaver's connections
	 * included. Then the user's connections stop receiving the room's
	 * deliveries and get `room_update` `left`, and then the result. The room
	 * stays visible and can be joined again. Leaving a room not joined
	 * changes nothing.
	 */
	private async handleRoomLeave(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity) throw { name: "denied", message: "Authenticate before leaving rooms" } satisfies ProtocolError;
		this.assertMayWrite(attachment);
		const roomId = requiredString(request.params, "room_id");
		if (!this.roomExists(roomId)) throw { name: "invalid_params", message: "Unknown room" } satisfies ProtocolError;
		const current = attachment.rooms ?? [];
		if (!current.includes(roomId)) {
			this.reply(socket, request, {});
			return;
		}
		if (identity.tier !== "registered") {
			this.setRooms(identity.user_id, current.filter((id) => id !== roomId));
			this.sendToUser(identity.user_id, roomUpdate("left", { room_id: roomId }));
			this.reply(socket, request, {});
			return;
		}
		await this.runMutation(async () => {
			const change = this.store.changeMembership({ userId: identity.user_id, ipKey: attachment.ipKey, roomId, join: false, now: nowMs() });
			// Delivered while the leaver is still a member.
			if (change.membership) this.broadcastRecord(change.membership);
			this.setRooms(identity.user_id, change.rooms);
			this.sendToUser(identity.user_id, roomUpdate("left", { room_id: roomId }));
			this.reply(socket, request, {});
		});
	}

	/**
	 * Activity (§4.4). Typing is relayed to the room's other members and never
	 * stored; without room_id it is in the default room. Read cursors are
	 * dropped: the demo neither keeps nor relays them. `away` is accepted and
	 * ignored, since the demo has no push; it is never delivered. At most
	 * `activityBroadcastsPerUserMinute` relays per user; past that the update
	 * is dropped and the sender gets one `@private` notice per minute.
	 */
	private async handleActivity(socket: WebSocketConnection, request: RequestFrame): Promise<void> {
		const attachment = connectionAttachment(socket);
		const identity = attachment ? publicIdentity(attachment) : null;
		if (!attachment || !identity) throw { name: "denied", message: "Authenticate first" } satisfies ProtocolError;
		const typing = request.params.typing;
		if (typing !== undefined && (typeof typing !== "number" || !Number.isFinite(typing) || typing < 0)) {
			throw { name: "invalid_params", message: "typing must be a non-negative number of seconds" } satisfies ProtocolError;
		}
		const roomId = request.params.room_id ?? ROOM_ID;
		if (typing !== undefined && (typeof roomId !== "string" || roomId.length === 0 || roomId.length > 64)) {
			throw { name: "invalid_params", message: "room_id must be a room" } satisfies ProtocolError;
		}
		if (request.id !== undefined) this.reply(socket, request, {});
		// A guest who only reads has nothing to be typing.
		if (attachment.tier === "anonymous" && !this.config.guestPosting) return;
		if (typing === undefined || typeof roomId !== "string" || !this.roomExists(roomId)) return;
		const now = nowMs();
		const limit = this.config.limits.activityBroadcastsPerUserMinute;
		if (!this.takeThrottle(socket, identity.user_id, "activity", limit, now)) {
			this.noticeThrottled(socket, identity.user_id, "activity", roomId, now,
				`Typing updates are limited to ${limit} per minute, so others may not see you typing for a moment.`);
			return;
		}
		const seconds = Math.min(Math.floor(typing), this.config.limits.activityMaxTypingSeconds);
		const frame = { method: "activity", params: { room_id: roomId, from: identity, typing: seconds } };
		this.deliver(frame, [roomId], undefined, socket);
	}

	/**
	 * `room_list` (§4.3.1): rooms matching the filters, in `joined` (every
	 * match, never truncated) and `not_joined` (visible rooms not joined:
	 * top-level ones, or with `parent_room_id` that room's threads), each most
	 * recently active first. `filter` (`joined`, `not_joined`, or `all`, the
	 * default) leaves out the other array; one it asks for is present even
	 * when empty. With `members: true`, each room carries its `members` and
	 * the result `users` (see membersOf). `latest_log_id` is validated and
	 * ignored: guests' memberships are not logged, so a delta could miss their
	 * joins and leaves, and a result without `left` is a full listing. At most
	 * `roomListRequestsPerUserMinute` listings per user, except the first
	 * `filter: "joined"` listing after authentication.
	 */
	private async handleRoomList(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity) throw { name: "denied", message: "Authenticate before listing rooms" } satisfies ProtocolError;
		const params = request.params;
		const filter = params.filter ?? "all";
		if (filter !== "joined" && filter !== "not_joined" && filter !== "all") {
			throw { name: "invalid_params", message: "filter must be joined, not_joined, or all" } satisfies ProtocolError;
		}
		if (params.members !== undefined && typeof params.members !== "boolean") throw { name: "invalid_params", message: "members must be a boolean" } satisfies ProtocolError;
		const withMembers = params.members === true;
		const parent = optionalString(params, "parent_room_id");
		const roomId = optionalString(params, "room_id");
		asDecimalId(params.latest_log_id, "latest_log_id");
		const joinedIds = new Set(attachment.rooms ?? []);
		const result: ListingResult = {};
		if (filter !== "not_joined") result.joined = [];
		if (filter !== "joined") result.not_joined = [];
		// Unjoined top-level rooms: `general` is the only one, so a user in it
		// has none, and the answer needs no storage or listing allowance.
		if (filter === "not_joined" && parent === undefined && roomId === undefined && joinedIds.has(ROOM_ID)) {
			if (withMembers) result.users = [];
			this.reply(socket, request, result);
			return;
		}
		const now = nowMs();
		const exempt = filter === "joined" && !attachment.listedJoined && parent === undefined && roomId === undefined;
		if (exempt) {
			attachment.listedJoined = true;
			writeAttachment(socket, attachment);
		} else {
			const retry = this.throttleRetry(identity.user_id, "room_list", this.config.limits.roomListRequestsPerUserMinute, now);
			if (retry !== undefined) throw { name: "retry_after", message: "Room listing limited", data: { retry_after: retry } } satisfies ProtocolError;
			// Counted before the storage read, so a listing of an unknown room counts too.
			this.takeThrottle(socket, identity.user_id, "room_list", Number.MAX_SAFE_INTEGER, now);
		}
		let candidates: RoomRecord[];
		if (roomId !== undefined) {
			const room = this.store.getRoom(roomId, now);
			this.noteRoom(roomId, room !== null);
			if (!room) throw { name: "invalid_params", message: "Unknown room" } satisfies ProtocolError;
			candidates = [room];
		} else {
			const rooms = this.store.listRooms(now);
			for (const room of rooms) this.noteRoom(room.room_id, true);
			if (parent !== undefined && !rooms.some((room) => room.room_id === parent)) throw { name: "invalid_params", message: "Unknown parent_room_id" } satisfies ProtocolError;
			candidates = rooms.filter((room) => parent === undefined ? true : room.parent_room_id === parent);
		}
		const byActivity = (a: RoomRecord, b: RoomRecord) => Number(b.latest_log_id) - Number(a.latest_log_id) || Number(b.log_id) - Number(a.log_id);
		for (const room of candidates.sort(byActivity)) {
			if (joinedIds.has(room.room_id)) result.joined?.push({ ...room });
			// Without parent_room_id, unjoined threads are left to their parent's listing.
			else if (roomId !== undefined || parent !== undefined || room.parent_room_id === undefined) result.not_joined?.push({ ...room });
		}
		if (withMembers) {
			const listed = [...(result.joined ?? []), ...(result.not_joined ?? [])];
			const members = this.membersOf(listed.map((room) => room.room_id));
			const users = new Map<string, PublicUser>();
			for (const room of listed) {
				const list = members.get(room.room_id) ?? [];
				room.members = list.map((member) => ({ user_id: member.user_id }));
				for (const member of list) users.set(member.user_id, member);
			}
			result.users = sortedUsers(users.values());
		}
		this.reply(socket, request, this.boundedListing(result));
	}

	/**
	 * Keeps a listing within the history response cap: `joined` is never
	 * truncated, so embedded intro snapshots become bare references first,
	 * and then, for a listing no realistic room reaches, `members` and
	 * `users` are left out.
	 */
	private boundedListing(result: ListingResult): ListingResult {
		const limit = this.config.limits.historyMaxResponseBytes;
		const fits = () => utf8Bytes(jsonString(result)) + 1_024 <= limit;
		if (fits()) return result;
		const rooms = [...(result.joined ?? []), ...(result.not_joined ?? [])];
		for (const room of rooms) {
			const intro = room.intro_message;
			if (intro && typeof intro.message_id === "string") room.intro_message = { message_id: intro.message_id };
		}
		if (!fits()) {
			for (const room of rooms) delete room.members;
			delete result.users;
		}
		return result;
	}

	/**
	 * `command` (§4.8): never logged, broadcast, or saved. The demo provides
	 * `/help`, which replies with a `@private` notice listing the commands the
	 * sender may run, and `/invite-bot` for registered users. An unknown
	 * command is an error the client shows; it is not a policy violation,
	 * since people mistype.
	 */
	private async handleCommand(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate first" } satisfies ProtocolError;
		const params = request.params;
		for (const name of ["message_id", "deleted"]) {
			if (params[name] !== undefined) throw { name: "invalid_params", message: `A command has no ${name}; send it as a message instead` } satisfies ProtocolError;
		}
		const roomId = optionalString(params, "room_id") ?? ROOM_ID;
		const body = objectParam(params, "body");
		if (!body) throw { name: "invalid_params", message: "Missing body" } satisfies ProtocolError;
		const text = optionalString(body, "text") ?? "";
		if (!this.roomExists(roomId)) throw { name: "invalid_params", message: "Unknown room" } satisfies ProtocolError;
		const line = text.trim();
		const name = line.startsWith("/") ? line.slice(1).split(/\s/, 1)[0].toLowerCase() : "";
		const command = COMMANDS.find((candidate) => candidate.name === name);
		if (!command) {
			const message = line.startsWith("/") ? `Unknown command /${name}; try /help` : "A command starts with /; try /help";
			this.fail(socket, request, { name: "invalid_params", message: message.slice(0, 200) });
			return;
		}
		const owner = attachment.tier === "registered" && !isBot(attachment.userId);
		if (command.audience === "owners" && !owner) {
			throw { name: "denied", message: isBot(attachment.userId) ? `A bot can't use /${name}` : `Sign in with a passkey to use /${name}` } satisfies ProtocolError;
		}
		if (command.name === "invite-bot") {
			await this.inviteBot(socket, attachment, request, roomId);
			return;
		}
		// The reply a command causes comes before its result (§1).
		const available = COMMANDS.filter((candidate) => candidate.audience === "everyone" || owner);
		this.send(socket, {
			method: "message",
			params: {
				room_id: roomId,
				from: { ...PRIVATE_IDENTITY },
				body: { text: available.map((candidate) => `- \`${candidate.usage}\`: ${candidate.help}`).join("\n"), format: "markdown" },
			},
		});
		this.reply(socket, request, {});
	}

	/**
	 * `/invite-bot`: creates the sender's bot, `bot_<user_id>` named after
	 * the sender, or renames it after the sender's current name, and mints its
	 * bearer token. The token replaces the last one, whose connections close.
	 * It goes to this connection only, in a `@private` notice (Appendix A.1),
	 * before the result (§1).
	 */
	private async inviteBot(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, roomId: string): Promise<void> {
		const ownerId = attachment.userId!;
		const botId = BOT_ID_PREFIX + ownerId;
		const name = botName(attachment.name || ownerId, this.config.limits);
		let bot!: ReturnType<Store["registerBot"]>;
		await this.runMutation(async () => {
			bot = this.store.registerBot({ ownerId, botId, name, now: nowMs(), ipKey: attachment.ipKey });
			// A new bot's logged join of `general` goes to its members (§4.3.2).
			for (const record of bot.broadcasts) this.broadcastRecord(record);
		});
		const token = await this.issueBotToken(botId, ownerId);
		for (const peer of this.connectionsOf(botId)) {
			const state = connectionAttachment(peer);
			if (state) this.closePolicy(peer, state, 1008, "Bot token replaced; sign in with the new one");
		}
		// Those who share a room with the bot see its new name (§3.3).
		if (bot.renamed) this.announceUser(socket, { user_id: botId, name }, this.store.getIdentity(botId)?.rooms ?? []);
		const endpoint = connectionAttachment(socket)?.endpoint ?? attachment.endpoint ?? "this server's WebSocket URL";
		this.send(socket, {
			method: "message",
			params: {
				room_id: roomId,
				from: { ...PRIVATE_IDENTITY },
				body: {
					text: [
						`Your bot signs in as **${name}** (\`${botId}\`) with this token. It replaces any earlier one, and anyone who has it can post as your bot, so keep it secret.`,
						"```\n" + token + "\n```",
						"If you're using an LLM, you can give it these instructions:",
						"```\n" + [
							`Read ${PROTOCOL_URL}`,
							`Connect to ${endpoint}`,
							`Auth using token scheme with this token: "${token}"`,
							"Say hello when you join and listen for messages",
						].join("\n") + "\n```",
					].join("\n\n"),
					format: "markdown",
				},
			},
		});
		this.reply(socket, request, {});
	}

	/**
	 * Each room's members as `room_list` and `room_update` `joined` carry them
	 * (§4.3.1), in `user_id` order with their current objects: the registered
	 * members stored with the room, at most `roomListMembers` per room, and
	 * every connected user who has joined it, guests included, whose
	 * memberships live in their connections.
	 */
	private membersOf(roomIds: readonly string[]): Map<string, PublicUser[]> {
		const stored = this.store.roomMembers(roomIds, this.config.limits.roomListMembers, nowMs());
		const connected = this.connectedMembers();
		const members = new Map<string, PublicUser[]>();
		for (const roomId of new Set(roomIds)) {
			const users = new Map<string, PublicUser>();
			for (const member of stored.get(roomId) ?? []) users.set(member.user_id, { user_id: member.user_id, name: member.name });
			for (const member of connected.get(roomId) ?? []) if (!users.has(member.user_id)) users.set(member.user_id, member);
			members.set(roomId, sortedUsers(users.values()));
		}
		return members;
	}

	/**
	 * A `room_update` `joined` for one room (§4.3.3): its record with its
	 * `members` as bare `{user_id}`, and `users`, their current objects.
	 * `joiner` is added to the members read before the join.
	 */
	private joinedUpdate(room: RoomRecord, members: readonly PublicUser[] = [], joiner?: PublicUser): Record<string, unknown> {
		const users = new Map(members.map((member) => [member.user_id, member]));
		if (joiner) users.set(joiner.user_id, joiner);
		const sorted = sortedUsers(users.values());
		return { method: "room_update", params: { joined: [{ ...room, members: sorted.map((member) => ({ user_id: member.user_id })) }], users: sorted } };
	}

	/** Each room's members connected now: users who have joined it, one entry each. */
	private connectedMembers(): Map<string, PublicUser[]> {
		this.closeStale(nowMs());
		const members = new Map<string, Map<string, PublicUser>>();
		for (const peer of this.ctx.getWebSockets()) {
			const state = connectionAttachment(peer as WebSocketConnection);
			const identity = state && !state.closing ? publicIdentity(state) : null;
			if (!identity) continue;
			for (const roomId of state!.rooms ?? []) {
				let listed = members.get(roomId);
				if (!listed) members.set(roomId, listed = new Map());
				listed.set(identity.user_id, identity);
			}
		}
		return new Map([...members].map(([roomId, listed]) => [roomId, [...listed.values()]]));
	}

	/**
	 * Whether a connection's peer has gone quiet: it has sent the liveness
	 * ping, but neither that nor any frame within the timeout. The runtime
	 * cannot ping, so a peer that vanished without a close frame (sleep, a
	 * network change) otherwise stays connected until the edge gives up on it.
	 * A connection that never pinged is never judged stale.
	 */
	private isStale(socket: WebSocket, now: number): boolean {
		const pinged = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime();
		if (pinged === undefined) return false;
		const frames = connectionAttachment(socket as WebSocketConnection)?.frameTimes ?? [];
		const heard = Math.max(pinged, frames[frames.length - 1] ?? 0);
		return heard <= now - this.config.limits.pingTimeoutSeconds * 1_000;
	}

	/**
	 * Closes stale connections. Nothing schedules this: it runs where a stale
	 * peer would be seen, before `members` are listed and before admission.
	 */
	private closeStale(now: number): void {
		const sockets = this.ctx.getWebSockets();
		let closed = 0;
		for (const ws of sockets) {
			const socket = ws as WebSocketConnection;
			const attachment = connectionAttachment(socket);
			if (!attachment || attachment.closing || !this.isStale(socket, now)) continue;
			attachment.closing = true;
			writeAttachment(socket, attachment);
			try { socket.close(1001, "Connection idle; reconnect to recover"); } catch { /* already closed */ }
			closed++;
		}
		// Shows in Workers Logs whether vanished peers are being found.
		if (closed) console.log(JSON.stringify({ event: "stale_connections_closed", closed, sockets: sockets.length }));
	}

	/**
	 * Sends an identity change (§3.3): `you` to the user's other connections,
	 * and `new` (with `old` when the `user_id` changed) to the connections of
	 * everyone else who shares one of `rooms` with the user. Joins and leaves
	 * are memberships, never `user` notifications (§4.3.2).
	 */
	private announceUser(origin: WebSocketConnection, identity: { user_id: string; name?: string } | null, rooms: readonly string[], old?: { user_id: string; name?: string } | null): void {
		if (!identity) return;
		const shared = new Set(rooms);
		for (const peer of this.ctx.getWebSockets()) {
			const socket = peer as WebSocketConnection;
			if (socket === origin) continue;
			const state = connectionAttachment(socket);
			if (!state) continue;
			if (state.userId === identity.user_id) this.deliverTo(socket, { method: "user", params: { you: identity } });
			else if (state.rooms?.some((id) => shared.has(id))) this.deliverTo(socket, { method: "user", params: { new: identity, ...(old ? { old } : {}) } });
		}
	}

	/** Authenticated, open connections of one user. */
	private connectionsOf(userId: string, except?: WebSocketConnection): WebSocketConnection[] {
		return this.ctx.getWebSockets().filter((peer) => {
			if (peer === except || !openSocket(peer)) return false;
			const state = connectionAttachment(peer as WebSocketConnection);
			return !!state && !state.closing && state.userId === userId && (state.tier === "anonymous" || state.tier === "registered");
		}) as WebSocketConnection[];
	}

	/** The rooms a user's other live connections have joined, if any is connected. */
	private liveRoomsOf(userId: string, except?: WebSocketConnection): string[] | undefined {
		for (const peer of this.connectionsOf(userId, except)) {
			const rooms = connectionAttachment(peer)?.rooms;
			if (rooms) return [...rooms];
		}
		return undefined;
	}

	/** Sets a user's joined rooms on every one of their connections. */
	private setRooms(userId: string, rooms: readonly string[]): void {
		const unique = [...new Set(rooms)].slice(0, MAX_ATTACHED_ROOMS);
		for (const peer of this.connectionsOf(userId)) {
			const state = connectionAttachment(peer);
			if (!state) continue;
			state.rooms = [...unique];
			writeAttachment(peer, state);
		}
	}

	/** Sends a frame to every connection of one user. */
	private sendToUser(userId: string, value: unknown): void {
		for (const peer of this.connectionsOf(userId)) this.deliverTo(peer, value);
	}

	/**
	 * Removed thread rooms (their entire log expired): their members leave
	 * them and are told with `room_update` `left` (§4.3.3).
	 */
	private removeRooms(roomIds: readonly string[]): void {
		const removed = new Set(roomIds);
		for (const ws of this.ctx.getWebSockets()) {
			const socket = ws as WebSocketConnection;
			const state = connectionAttachment(socket);
			if (!state?.rooms?.some((id) => removed.has(id))) continue;
			const left = state.rooms.filter((id) => removed.has(id));
			state.rooms = state.rooms.filter((id) => !removed.has(id));
			writeAttachment(socket, state);
			this.deliverTo(socket, { method: "room_update", params: { left: left.map((room_id) => ({ room_id })) } });
		}
	}

	/**
	 * Rooms whose delivery fields changed, such as a raised `history_log_id`,
	 * as `room_update` `updated` to the members of each room and of its parent.
	 */
	private announceUpdated(rooms: readonly RoomRecord[]): void {
		if (!rooms.length) return;
		for (const ws of this.ctx.getWebSockets()) {
			const socket = ws as WebSocketConnection;
			const joined = new Set(connectionAttachment(socket)?.rooms ?? []);
			const relevant = rooms.filter((room) => joined.has(room.room_id) || (room.parent_room_id !== undefined && joined.has(room.parent_room_id)));
			if (relevant.length) this.deliverTo(socket, { method: "room_update", params: { updated: relevant } });
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
	 * Tells a throttled sender, once per window per user, with a `@private`
	 * notice (Appendix A.1) in the room they were active in. It goes to that
	 * connection only, is never logged, and carries no message_id or log_id.
	 */
	private noticeThrottled(socket: WebSocketConnection, userId: string, type: ThrottledType, roomId: string, now: number, text: string): void {
		for (const peer of this.ctx.getWebSockets()) {
			const state = connectionAttachment(peer as WebSocketConnection);
			if (state?.userId === userId && (state.notices?.[type] ?? 0) > now - THROTTLE_WINDOW_MS) return;
		}
		const state = connectionAttachment(socket);
		if (!state) return;
		state.notices = { ...state.notices, [type]: now };
		writeAttachment(socket, state);
		this.deliverTo(socket, {
			method: "message",
			params: { room_id: roomId, from: { ...PRIVATE_IDENTITY }, body: { text, format: "plain" } },
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
	 * Delivers one committed record to the members of the rooms it belongs to
	 * (§3.4): a moved message's snapshot reaches both rooms' members in one
	 * frame, delivered once per connection (section 3.5).
	 */
	private broadcastRecord(record: Broadcast): void {
		this.deliver({ method: record.method, params: record.params }, record.rooms);
	}

	/**
	 * Sends to every authenticated connection whose user has joined one of
	 * `rooms` and passes `filter`, except `except`.
	 */
	private deliver(value: unknown, rooms: readonly string[], filter?: (state: ConnectionAttachment) => boolean, except?: WebSocketConnection): void {
		for (const ws of this.ctx.getWebSockets()) {
			const socket = ws as WebSocketConnection;
			if (socket === except) continue;
			const state = connectionAttachment(socket);
			if (!state?.rooms?.some((id) => rooms.includes(id)) || (filter && !filter(state))) continue;
			this.deliverTo(socket, value);
		}
	}

	/** Sends to one connection if it is authenticated; a failed send closes it so its client recovers. */
	private deliverTo(socket: WebSocketConnection, value: unknown): void {
		const attachment = connectionAttachment(socket);
		if (!attachment || attachment.closing || (attachment.tier !== "anonymous" && attachment.tier !== "registered")) return;
		if (!this.send(socket, value)) {
			attachment.closing = true;
			writeAttachment(socket, attachment);
			try { socket.close(1011, "Delivery failed; reconnect to recover"); } catch { /* closed */ }
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
