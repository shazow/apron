export interface Limits {
	retentionSeconds: number;
	cleanupSeconds: number;
	challengeTtlSeconds: number;
	maxFrameBytes: number;
	maxTextBytes: number;
	maxSnapshotBytes: number;
	maxJsonDepth: number;
	maxJsonNodes: number;
	maxRequestIdBytes: number;
	maxNameCodePoints: number;
	maxNameBytes: number;
	maxEmbeds: number;
	historyDefaultLimit: number;
	historyMaxLimit: number;
	historyMaxResponseBytes: number;
	historyRequestsPerUserMinute: number;
	historyRequestsPerIpMinute: number;
	concurrentHistoryPerConnection: number;
	anonymousPostsPerMinute: number;
	anonymousPostsPerDay: number;
	registeredPostsPerMinute: number;
	registeredPostsPerDay: number;
	ipPostsPerMinute: number;
	ipPostsPerDay: number;
	globalPostsPerMinute: number;
	globalPostsPerDay: number;
	registrationsPerIpDay: number;
	registrationsPerDay: number;
	registeredIdentityCount: number;
	authAttemptsPerIpMinute: number;
	openConnections: number;
	anonymousConnectionsPerIp: number;
	registeredConnectionsPerUser: number;
	connectionsPerIp: number;
	connectionAdmissionsPerIpMinute: number;
	connectionAdmissionsPerDay: number;
	unauthenticatedTimeoutSeconds: number;
	pendingFramesPerConnection: number;
	pendingBytesPerConnection: number;
	framesPerConnectionMinute: number;
	framesPerIpMinute: number;
	processedFramesPerDay: number;
	repeatedPolicyViolations: number;
	sqlWritesPerDay: number;
	sqlReadsPerDay: number;
	foregroundWritesPerDay: number;
	maintenanceWritesPerDay: number;
	foregroundReadsPerDay: number;
	maintenanceReadsPerDay: number;
	databaseHighWaterBytes: number;
	databaseHardTargetBytes: number;
	databaseResumeLowWaterBytes: number;
	cleanupBatch: number;
	threadLimit: number;
	threadMetadataBytes: number;
	dedupTtlSeconds: number;
	limiterRecordCap: number;
	maxCredentialBytes: number;
	maxChallengeBytes: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
	retentionSeconds: 86_400,
	cleanupSeconds: 3_600,
	challengeTtlSeconds: 120,
	maxFrameBytes: 16_384,
	maxTextBytes: 4_096,
	maxSnapshotBytes: 8_192,
	maxJsonDepth: 8,
	maxJsonNodes: 2_048,
	maxRequestIdBytes: 128,
	maxNameCodePoints: 80,
	maxNameBytes: 320,
	maxEmbeds: 4,
	historyDefaultLimit: 20,
	historyMaxLimit: 50,
	historyMaxResponseBytes: 262_144,
	historyRequestsPerUserMinute: 10,
	historyRequestsPerIpMinute: 30,
	concurrentHistoryPerConnection: 1,
	anonymousPostsPerMinute: 5,
	anonymousPostsPerDay: 100,
	registeredPostsPerMinute: 20,
	registeredPostsPerDay: 500,
	ipPostsPerMinute: 30,
	ipPostsPerDay: 1_000,
	globalPostsPerMinute: 60,
	globalPostsPerDay: 5_000,
	registrationsPerIpDay: 3,
	registrationsPerDay: 100,
	registeredIdentityCount: 10_000,
	authAttemptsPerIpMinute: 10,
	openConnections: 100,
	anonymousConnectionsPerIp: 2,
	registeredConnectionsPerUser: 3,
	connectionsPerIp: 10,
	connectionAdmissionsPerIpMinute: 5,
	connectionAdmissionsPerDay: 2_000,
	unauthenticatedTimeoutSeconds: 30,
	pendingFramesPerConnection: 8,
	pendingBytesPerConnection: 131_072,
	framesPerConnectionMinute: 60,
	framesPerIpMinute: 120,
	processedFramesPerDay: 100_000,
	repeatedPolicyViolations: 3,
	sqlWritesPerDay: 80_000,
	sqlReadsPerDay: 3_000_000,
	foregroundWritesPerDay: 60_000,
	maintenanceWritesPerDay: 20_000,
	foregroundReadsPerDay: 2_500_000,
	maintenanceReadsPerDay: 500_000,
	databaseHighWaterBytes: 96 * 1024 * 1024,
	databaseHardTargetBytes: 128 * 1024 * 1024,
	databaseResumeLowWaterBytes: 80 * 1024 * 1024,
	cleanupBatch: 100,
	threadLimit: 100,
	threadMetadataBytes: 2 * 1024,
	dedupTtlSeconds: 86_400,
	limiterRecordCap: 10_000,
	maxCredentialBytes: 16 * 1024,
	maxChallengeBytes: 16 * 1024,
});

export interface RuntimeConfig {
	limits: Limits;
	allowedOrigins: readonly string[];
	rpId: string;
	rpOrigins: readonly string[];
	rpName: string;
	ipHmacSecret: string;
	operatorSecret?: string;
	admissionOff: boolean;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

// These are deployment ceilings, rather than alternate defaults.  Operators
// may lower any limit below; a value above one of these bounds would make the
// corresponding attachment, parser, SQLite, or Free-plan accounting budget
// unbounded relative to the implementation that consumes it.
const MAX_FRAME_BYTES = 16 * 1024;
const MAX_TEXT_BYTES = 4 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 2_048;
const MAX_REQUEST_ID_BYTES = 128;
const MAX_NAME_CODE_POINTS = 80;
const MAX_NAME_BYTES = 320;
const MAX_EMBEDS = 4;
const MAX_HISTORY_LIMIT = 50;
const MAX_HISTORY_RESPONSE_BYTES = 256 * 1024;
const MAX_PENDING_FRAMES = 8;
const MAX_PENDING_BYTES = 128 * 1024;
const MAX_CONCURRENT_HISTORY = 1;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_CHALLENGE_BYTES = 16 * 1024;
const MAX_OPEN_CONNECTIONS = 100;
const MAX_REGISTERED_IDENTITIES = 10_000;
const MAX_LIMITER_RECORDS = 10_000;
const MAX_PROCESSED_FRAMES = 100_000;
const MAX_GLOBAL_POSTS_PER_MINUTE = 60;
const MAX_GLOBAL_POSTS_PER_DAY = 5_000;
const MAX_REGISTRATIONS_PER_DAY = 100;
const MAX_CLEANUP_BATCH = 100;
const MAX_THREAD_LIMIT = 100;
const MAX_THREAD_METADATA_BYTES = 2 * 1024;
const MAX_CONNECTION_FRAME_RATE = 120;
const MAX_SQL_WRITES = 80_000;
const MAX_SQL_READS = 3_000_000;
const MAX_DATABASE_HIGH_WATER_BYTES = 96 * 1024 * 1024;
const MAX_DATABASE_HARD_TARGET_BYTES = 128 * 1024 * 1024;
const MAINTENANCE_CONTROL_RESERVE = 8;
export const BOOTSTRAP_ROW_RESERVATION = 512;
const MAX_SOCKET_QUEUE_ALLOCATION = 32 * 1024 * 1024;

type EnvLike = {
	ALLOWED_ORIGINS?: string;
	RP_ID?: string;
	RP_ORIGINS?: string;
	RP_NAME?: string;
	IP_HMAC_SECRET?: string;
	OPERATOR_SECRET?: string;
	ADMISSION_OFF?: string;
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
	if (limits.maxFrameBytes > MAX_FRAME_BYTES) fail("maxFrameBytes cannot exceed the demo frame policy");
	if (limits.maxTextBytes > MAX_TEXT_BYTES || limits.maxTextBytes > limits.maxFrameBytes || limits.maxTextBytes > limits.maxSnapshotBytes) {
		fail("text payload exceeds the frame or snapshot policy");
	}
	if (limits.maxSnapshotBytes > MAX_SNAPSHOT_BYTES || limits.maxSnapshotBytes > limits.maxFrameBytes) {
		fail("snapshot payload exceeds the frame policy");
	}
	if (limits.maxJsonDepth > MAX_JSON_DEPTH || limits.maxJsonNodes > MAX_JSON_NODES || limits.maxRequestIdBytes > MAX_REQUEST_ID_BYTES) {
		fail("JSON policy exceeds calibrated bounds");
	}
	if (limits.maxRequestIdBytes > limits.maxFrameBytes || limits.maxNameCodePoints > MAX_NAME_CODE_POINTS || limits.maxNameBytes > MAX_NAME_BYTES) {
		fail("metadata policy exceeds calibrated bounds");
	}
	if (limits.maxNameBytes > limits.maxSnapshotBytes || limits.maxEmbeds > MAX_EMBEDS) {
		fail("message metadata cannot fit the snapshot policy");
	}
	if (limits.maxCredentialBytes > MAX_CREDENTIAL_BYTES || limits.maxCredentialBytes > limits.maxFrameBytes || limits.maxChallengeBytes > MAX_CHALLENGE_BYTES || limits.maxChallengeBytes > limits.maxFrameBytes) {
		fail("authentication payload exceeds the frame policy");
	}

	if (limits.historyMaxLimit > MAX_HISTORY_LIMIT || limits.historyDefaultLimit > limits.historyMaxLimit) {
		fail("history default exceeds the bounded history maximum");
	}
	if (limits.historyMaxResponseBytes > MAX_HISTORY_RESPONSE_BYTES || limits.maxSnapshotBytes + 1024 > limits.historyMaxResponseBytes) {
		fail("history response cap cannot contain one snapshot");
	}
	if (limits.concurrentHistoryPerConnection > MAX_CONCURRENT_HISTORY) {
		fail("concurrent history is limited to one request per connection");
	}

	if (limits.pendingFramesPerConnection > MAX_PENDING_FRAMES || limits.pendingBytesPerConnection > MAX_PENDING_BYTES) {
		fail("socket pending-work policy exceeds calibrated bounds");
	}
	if (limits.pendingBytesPerConnection < limits.maxFrameBytes || limits.pendingFramesPerConnection > Math.floor(limits.pendingBytesPerConnection / limits.maxFrameBytes)) {
		fail("pending socket budget cannot hold its configured frames");
	}
	if (limits.openConnections > MAX_OPEN_CONNECTIONS || limits.openConnections * limits.pendingBytesPerConnection > MAX_SOCKET_QUEUE_ALLOCATION) {
		fail("socket queues exceed the demo memory allocation");
	}

	if (limits.registeredIdentityCount > MAX_REGISTERED_IDENTITIES || limits.limiterRecordCap > MAX_LIMITER_RECORDS) {
		fail("identity or limiter records exceed the calibrated bound");
	}
	if (limits.anonymousConnectionsPerIp > limits.connectionsPerIp || limits.connectionsPerIp > limits.openConnections || limits.registeredConnectionsPerUser > limits.openConnections) {
		fail("connection limits exceed their enclosing scope");
	}
	if (limits.connectionAdmissionsPerIpMinute > limits.connectionAdmissionsPerDay) {
		fail("connection admission minute limit exceeds its daily limit");
	}

	if (limits.framesPerConnectionMinute > MAX_CONNECTION_FRAME_RATE || limits.framesPerConnectionMinute > limits.framesPerIpMinute || limits.framesPerIpMinute > limits.processedFramesPerDay || limits.processedFramesPerDay > MAX_PROCESSED_FRAMES || limits.repeatedPolicyViolations > limits.framesPerConnectionMinute) {
		fail("connection attachment counters exceed bounded policy");
	}
	if (limits.globalPostsPerMinute > MAX_GLOBAL_POSTS_PER_MINUTE || limits.globalPostsPerDay > MAX_GLOBAL_POSTS_PER_DAY || limits.globalPostsPerMinute > limits.globalPostsPerDay) {
		fail("global posting policy exceeds the demo ceiling");
	}
	if (limits.anonymousPostsPerMinute > limits.anonymousPostsPerDay || limits.registeredPostsPerMinute > limits.registeredPostsPerDay || limits.ipPostsPerMinute > limits.ipPostsPerDay) {
		fail("posting minute limit exceeds its daily limit");
	}
	if (limits.registrationsPerIpDay > limits.registrationsPerDay || limits.registrationsPerDay > MAX_REGISTRATIONS_PER_DAY) {
		fail("registration policy exceeds the demo ceiling");
	}

	if (limits.databaseResumeLowWaterBytes >= limits.databaseHighWaterBytes || limits.databaseHighWaterBytes >= limits.databaseHardTargetBytes) {
		fail("database watermarks must be low < high < hard target");
	}
	if (limits.databaseHighWaterBytes > MAX_DATABASE_HIGH_WATER_BYTES || limits.databaseHardTargetBytes > MAX_DATABASE_HARD_TARGET_BYTES) {
		fail("resource ceilings exceed the demo allocation");
	}
	if (limits.retentionSeconds < limits.cleanupSeconds) fail("retention must be at least one cleanup interval");
	if (limits.cleanupBatch > MAX_CLEANUP_BATCH || limits.threadLimit > MAX_THREAD_LIMIT || limits.threadMetadataBytes > MAX_THREAD_METADATA_BYTES) {
		fail("metadata or cleanup exceeds calibrated bounds");
	}
	if (limits.sqlWritesPerDay > MAX_SQL_WRITES || limits.sqlReadsPerDay > MAX_SQL_READS) {
		fail("SQL ceilings exceed the demo allocation");
	}
	if (limits.maintenanceReadsPerDay < BOOTSTRAP_ROW_RESERVATION + MAINTENANCE_CONTROL_RESERVE || limits.maintenanceWritesPerDay < BOOTSTRAP_ROW_RESERVATION + MAINTENANCE_CONTROL_RESERVE) {
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
	const rpOrigins = splitList(env.RP_ORIGINS, allowedOrigins);
	if (allowedOrigins.length === 0 || allowedOrigins.some((origin) => !validOrigin(origin))) {
		throw new ConfigError("ALLOWED_ORIGINS must contain exact HTTP(S) origins");
	}
	if (rpOrigins.length === 0 || rpOrigins.some((origin) => !validOrigin(origin))) {
		throw new ConfigError("RP_ORIGINS must contain exact HTTP(S) origins");
	}
	if (rpOrigins.some((origin) => !allowedOrigins.includes(origin))) throw new ConfigError("RP_ORIGINS must be a subset of ALLOWED_ORIGINS");
	const rpId = (env.RP_ID === undefined ? "localhost" : String(env.RP_ID)).trim().toLowerCase();
	if (!rpId || rpId.includes("://") || rpId.includes("/") || rpId.includes(" ")) throw new ConfigError("RP_ID must be a host name");
	for (const origin of rpOrigins) {
		const hostname = new URL(origin).hostname.toLowerCase();
		if (hostname !== rpId && !hostname.endsWith(`.${rpId}`)) throw new ConfigError(`RP_ID is not valid for origin ${origin}`);
	}
	const ipHmacSecret = String(env.IP_HMAC_SECRET ?? "");
	if (new TextEncoder().encode(ipHmacSecret).byteLength < 32) throw new ConfigError("IP_HMAC_SECRET must be at least 32 UTF-8 bytes");
	if (env.ADMISSION_OFF !== undefined && !["true", "false"].includes(String(env.ADMISSION_OFF).toLowerCase())) throw new ConfigError("ADMISSION_OFF must be true or false");
	const admissionOff = String(env.ADMISSION_OFF ?? "").toLowerCase() === "true";
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
		ipHmacSecret,
		operatorSecret: env.OPERATOR_SECRET ? String(env.OPERATOR_SECRET) : undefined,
		admissionOff,
	};
}

export function isAllowedOrigin(config: RuntimeConfig, origin: string | null): boolean {
	return origin === null || config.allowedOrigins.includes(origin);
}
