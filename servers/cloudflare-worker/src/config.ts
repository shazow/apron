import * as budget from "./budget.ts";
import { DEFAULT_LIMITS, type Limits } from "./budget.ts";
export { DEFAULT_LIMITS, BOOTSTRAP_ROW_RESERVATION, type Limits } from "./budget.ts";

export interface RuntimeConfig {
	limits: Limits;
	allowedOrigins: readonly string[];
	rpId: string;
	rpOrigins: readonly string[];
	rpName: string;
	admissionOff: boolean;
	/** Advertise and relay typing (cap `activity`); off unless `ACTIVITY=true`. */
	activityEnabled: boolean;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

type EnvLike = {
	ALLOWED_ORIGINS?: string;
	RP_ID?: string;
	RP_ORIGINS?: string;
	RP_NAME?: string;
	ADMISSION_OFF?: string;
	ACTIVITY?: string;
	ENVIRONMENT?: string;
	NODE_ENV?: string;
};

function splitList(value: string | undefined, fallback: string[]): string[] {
	const values = (value ?? fallback.join(","))
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return [...new Set(values)];
}

function validOrigin(origin: string): boolean {
	try {
		const parsed = new URL(origin);
		return origin === parsed.origin &&
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			(parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]") &&
			parsed.username === "" && parsed.password === "" && parsed.pathname === "/" &&
			parsed.search === "" && parsed.hash === "";
	} catch {
		return false;
	}
}

function parsePositiveInt(env: EnvLike, name: string, fallback: number): number {
	const envName = name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
	const values = env as EnvLike & Record<string, unknown>;
	const raw = values[`LIMIT_${envName}`] ?? values[envName] ?? values[name];
	if (raw === undefined || raw === "") return fallback;
	const value = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) throw new ConfigError(`${name} must be a positive safe integer`);
	return value;
}

function validateLimits(limits: Limits): void {
	const fail = (message: string): never => { throw new ConfigError(message); };

	// Parser, serializer, and attachment bounds are coupled.  Keeping these
	// relationships here prevents a lower-level store or a socket handler from
	// receiving a combination that can accept data it cannot carry safely.
	if (limits.maxFrameBytes > budget.MAX_FRAME_BYTES) fail("maxFrameBytes cannot exceed the demo frame policy");
	if (limits.maxTextBytes > budget.MAX_TEXT_BYTES || limits.maxTextBytes > limits.maxFrameBytes || limits.maxTextBytes > limits.maxSnapshotBytes) {
		fail("text payload exceeds the frame or snapshot policy");
	}
	if (limits.maxSnapshotBytes > budget.MAX_SNAPSHOT_BYTES || limits.maxSnapshotBytes > limits.maxFrameBytes) {
		fail("snapshot payload exceeds the frame policy");
	}
	if (limits.maxJsonDepth > budget.MAX_JSON_DEPTH || limits.maxJsonNodes > budget.MAX_JSON_NODES || limits.maxRequestIdBytes > budget.MAX_REQUEST_ID_BYTES) {
		fail("JSON policy exceeds calibrated bounds");
	}
	if (limits.maxRequestIdBytes > limits.maxFrameBytes || limits.maxNameCodePoints > budget.MAX_NAME_CODE_POINTS || limits.maxNameBytes > budget.MAX_NAME_BYTES) {
		fail("metadata policy exceeds calibrated bounds");
	}
	if (limits.maxNameBytes > limits.maxSnapshotBytes || limits.maxEmbeds > budget.MAX_EMBEDS) {
		fail("message metadata cannot fit the snapshot policy");
	}
	if (limits.maxCredentialBytes > budget.MAX_CREDENTIAL_BYTES || limits.maxCredentialBytes > limits.maxFrameBytes || limits.maxChallengeBytes > budget.MAX_CHALLENGE_BYTES || limits.maxChallengeBytes > limits.maxFrameBytes) {
		fail("authentication payload exceeds the frame policy");
	}

	if (limits.historyMaxLimit > budget.MAX_HISTORY_LIMIT || limits.historyDefaultLimit > limits.historyMaxLimit) {
		fail("history default exceeds the bounded history maximum");
	}
	if (limits.historyMaxResponseBytes > budget.MAX_HISTORY_RESPONSE_BYTES || limits.maxSnapshotBytes + 1024 > limits.historyMaxResponseBytes) {
		fail("history response cap cannot contain one snapshot");
	}
	if (limits.concurrentHistoryPerConnection > budget.MAX_CONCURRENT_HISTORY) {
		fail("concurrent history is limited to one request per connection");
	}

	if (limits.pendingFramesPerConnection > budget.MAX_PENDING_FRAMES || limits.pendingBytesPerConnection > budget.MAX_PENDING_BYTES) {
		fail("socket pending-work policy exceeds calibrated bounds");
	}
	if (limits.pendingBytesPerConnection < limits.maxFrameBytes || limits.pendingFramesPerConnection > Math.floor(limits.pendingBytesPerConnection / limits.maxFrameBytes)) {
		fail("pending socket budget cannot hold its configured frames");
	}
	if (limits.openConnections > budget.MAX_OPEN_CONNECTIONS || limits.openConnections * limits.pendingBytesPerConnection > budget.MAX_SOCKET_QUEUE_ALLOCATION) {
		fail("socket queues exceed the demo memory allocation");
	}

	if (limits.registeredIdentityCount > budget.MAX_REGISTERED_IDENTITIES || limits.limiterRecordCap > budget.MAX_LIMITER_RECORDS) {
		fail("identity or limiter records exceed the calibrated bound");
	}
	if (limits.anonymousConnectionsPerIp > limits.connectionsPerIp || limits.connectionsPerIp > limits.openConnections || limits.registeredConnectionsPerUser > limits.openConnections) {
		fail("connection limits exceed their enclosing scope");
	}
	if (limits.connectionAdmissionsPerIpMinute > limits.connectionAdmissionsPerDay) {
		fail("connection admission minute limit exceeds its daily limit");
	}

	if (limits.framesPerConnectionMinute > budget.MAX_CONNECTION_FRAME_RATE || limits.framesPerConnectionMinute > limits.framesPerIpMinute || limits.framesPerIpMinute > limits.processedFramesPerDay || limits.processedFramesPerDay > budget.MAX_PROCESSED_FRAMES || limits.repeatedPolicyViolations > limits.framesPerConnectionMinute) {
		fail("connection attachment counters exceed bounded policy");
	}
	if (limits.framesPerIpMinute > limits.globalFramesPerMinute || limits.globalFramesPerMinute > budget.MAX_GLOBAL_FRAMES_PER_MINUTE || limits.globalFramesPerMinute > limits.processedFramesPerDay) {
		fail("the server-wide frame minute limit must hold one IP's allowance and fit the daily frame budget");
	}
	if (limits.activityBroadcastsPerUserMinute > budget.MAX_TYPE_THROTTLE_PER_MINUTE || limits.roomListRequestsPerUserMinute > budget.MAX_TYPE_THROTTLE_PER_MINUTE) {
		fail("per-type throttles exceed their attachment bound");
	}
	if (limits.frameLease > budget.MAX_FRAME_LEASE || limits.frameLease > limits.framesPerConnectionMinute || limits.frameLease * limits.anonymousConnectionsPerIp > limits.framesPerIpMinute) {
		fail("frame blocks exceed the per-connection or per-IP frame policy");
	}
	if (limits.roomListMembers > budget.MAX_ROOM_LIST_MEMBERS || limits.roomListMembers > limits.openConnections) {
		fail("room_list members exceed the calibrated bound");
	}
	if (limits.pingTimeoutSeconds < 2 * limits.pingSeconds) {
		fail("the ping timeout must outlast a missed ping");
	}
	if (limits.globalPostsPerMinute > budget.MAX_GLOBAL_POSTS_PER_MINUTE || limits.globalPostsPerDay > budget.MAX_GLOBAL_POSTS_PER_DAY || limits.globalPostsPerMinute > limits.globalPostsPerDay) {
		fail("global posting policy exceeds the demo ceiling");
	}
	if (limits.anonymousPostsPerMinute > limits.anonymousPostsPerDay || limits.registeredPostsPerMinute > limits.registeredPostsPerDay || limits.ipPostsPerMinute > limits.ipPostsPerDay) {
		fail("posting minute limit exceeds its daily limit");
	}
	if (limits.registrationsPerIpDay > limits.registrationsPerDay || limits.registrationsPerDay > budget.MAX_REGISTRATIONS_PER_DAY) {
		fail("registration policy exceeds the demo ceiling");
	}

	if (limits.databaseResumeLowWaterBytes >= limits.databaseHighWaterBytes || limits.databaseHighWaterBytes >= limits.databaseHardTargetBytes) {
		fail("database watermarks must be low < high < hard target");
	}
	if (limits.databaseHighWaterBytes > budget.MAX_DATABASE_HIGH_WATER_BYTES || limits.databaseHardTargetBytes > budget.MAX_DATABASE_HARD_TARGET_BYTES) {
		fail("resource ceilings exceed the demo allocation");
	}
	if (limits.retentionSeconds < limits.cleanupSeconds) fail("retention must be at least one cleanup interval");
	if (!Number.isSafeInteger(limits.sessionTtlSeconds) || limits.sessionTtlSeconds <= 0 || limits.sessionTtlSeconds > 30 * 24 * 60 * 60) {
		fail("session lifetime must be between one second and thirty days");
	}
	if (limits.cleanupBatch > budget.MAX_CLEANUP_BATCH || limits.threadLimit > budget.MAX_THREAD_LIMIT || limits.threadMetadataBytes > budget.MAX_THREAD_METADATA_BYTES) {
		fail("metadata or cleanup exceeds calibrated bounds");
	}
	if (limits.reactionUsersPerMessage > budget.MAX_REACTION_USERS_PER_MESSAGE || limits.reactionEmojisPerUser > budget.MAX_REACTION_EMOJIS_PER_USER) {
		fail("reaction policy exceeds calibrated bounds");
	}
	// A moved message carries every reaction set in one logged record, which
	// must still fit one history response (escaped emoji and names included).
	if (limits.reactionUsersPerMessage * (2 * budget.MAX_EMOJI_BYTES * limits.reactionEmojisPerUser + 2 * limits.maxNameBytes + 256) + 1024 > limits.historyMaxResponseBytes) {
		fail("a moved message's reaction record cannot fit one history response");
	}
	if (limits.sqlWritesPerDay > budget.MAX_SQL_WRITES || limits.sqlReadsPerDay > budget.MAX_SQL_READS) {
		fail("SQL ceilings exceed the demo allocation");
	}
	if (limits.maintenanceReadsPerDay < budget.BOOTSTRAP_ROW_RESERVATION + budget.MAINTENANCE_CONTROL_RESERVE || limits.maintenanceWritesPerDay < budget.BOOTSTRAP_ROW_RESERVATION + budget.MAINTENANCE_CONTROL_RESERVE) {
		fail("maintenance budgets must cover bootstrap and the control reserve");
	}
	if (limits.foregroundReadsPerDay + limits.maintenanceReadsPerDay > limits.sqlReadsPerDay || limits.foregroundWritesPerDay + limits.maintenanceWritesPerDay > limits.sqlWritesPerDay) {
		fail("foreground and maintenance budgets exceed SQL daily ceilings");
	}
}

/** Load and validate immutable deployment policy before accepting a socket. */
export function loadConfig(env: EnvLike, overrides: Partial<Limits> = {}): RuntimeConfig {
	const limits = { ...DEFAULT_LIMITS } as Limits;
	for (const key of Object.keys(limits) as (keyof Limits)[]) {
		limits[key] = parsePositiveInt(env, key, limits[key]);
	}
	Object.assign(limits, overrides);
	for (const [key, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new ConfigError(`${key} must be a positive safe integer`);
	}
	validateLimits(limits);

	const hasConfiguredOrigins = env.ALLOWED_ORIGINS !== undefined || env.RP_ORIGINS !== undefined;
	const developmentDefaults = String(env.ENVIRONMENT ?? "").toLowerCase() === "development" || String(env.NODE_ENV ?? "").toLowerCase() === "test";
	if (!hasConfiguredOrigins && !developmentDefaults) throw new ConfigError("ALLOWED_ORIGINS and RP_ORIGINS must be configured");
	const allowedOrigins = splitList(env.ALLOWED_ORIGINS, ["http://localhost:5173", "http://localhost:8787"]);
	const allowAnyOrigin = allowedOrigins.length === 1 && allowedOrigins[0] === "*";
	const rpOrigins = splitList(env.RP_ORIGINS, allowedOrigins);
	if (!allowAnyOrigin && (allowedOrigins.length === 0 || allowedOrigins.some((origin) => !validOrigin(origin)))) {
		throw new ConfigError("ALLOWED_ORIGINS must contain exact HTTP(S) origins or a standalone *");
	}
	if (allowAnyOrigin && env.RP_ORIGINS === undefined) throw new ConfigError("RP_ORIGINS must be explicit when ALLOWED_ORIGINS is *");
	if (rpOrigins.length === 0 || rpOrigins.some((origin) => !validOrigin(origin))) {
		throw new ConfigError("RP_ORIGINS must contain exact HTTP(S) origins");
	}
	if (!allowAnyOrigin && rpOrigins.some((origin) => !allowedOrigins.includes(origin))) throw new ConfigError("RP_ORIGINS must be a subset of ALLOWED_ORIGINS");
	const rpId = (env.RP_ID === undefined ? "localhost" : String(env.RP_ID)).trim().toLowerCase();
	if (!rpId || rpId.includes("://") || rpId.includes("/") || rpId.includes(" ")) throw new ConfigError("RP_ID must be a host name");
	for (const origin of rpOrigins) {
		const hostname = new URL(origin).hostname.toLowerCase();
		if (hostname !== rpId && !hostname.endsWith(`.${rpId}`)) throw new ConfigError(`RP_ID is not valid for origin ${origin}`);
	}
	if (env.ADMISSION_OFF !== undefined && !["true", "false"].includes(String(env.ADMISSION_OFF).toLowerCase())) throw new ConfigError("ADMISSION_OFF must be true or false");
	const admissionOff = String(env.ADMISSION_OFF ?? "").toLowerCase() === "true";
	if (env.ACTIVITY !== undefined && !["true", "false"].includes(String(env.ACTIVITY).toLowerCase())) throw new ConfigError("ACTIVITY must be true or false");
	const activityEnabled = String(env.ACTIVITY ?? "").toLowerCase() === "true";
	const rpName = String(env.RP_NAME ?? "Apron Demo");
	if (!rpName.trim() || [...rpName].length > limits.maxNameCodePoints || new TextEncoder().encode(rpName).byteLength > limits.maxNameBytes) {
		throw new ConfigError("RP_NAME exceeds the configured display-name policy");
	}
	return {
		limits,
		allowedOrigins,
		rpId,
		rpOrigins,
		rpName,
		admissionOff,
		activityEnabled,
	};
}

export function isAllowedOrigin(config: RuntimeConfig, origin: string | null): boolean {
	return config.allowedOrigins.includes("*") || origin === null || config.allowedOrigins.includes(origin);
}
