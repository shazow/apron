// Single source for deployment resource policy. Keep the account on Workers Free.
export interface Limits {
	retentionSeconds: number;
	cleanupSeconds: number;
	challengeTtlSeconds: number;
	/** Lifetime of a passkey session token, renewed on every successful resume. */
	sessionTtlSeconds: number;
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
	/**
	 * Frames the whole server processes in a rolling minute, counted in memory
	 * before any SQL. Past it, requests get `retry_after` and notifications are
	 * dropped; the socket stays open. Sized for a spike from 50 connected users,
	 * 10 of them active: about 20 frames a minute per active user (posts,
	 * reactions, edits, history pages, room lookups), one per quiet user, and a
	 * reconnect wave of auth plus a history page each.
	 */
	globalFramesPerMinute: number;
	/**
	 * Per-type throttles, counted per user across their connections. Activity
	 * over its limit is dropped and the sender gets one `@server` notice per
	 * window; other requests over theirs are answered with `retry_after`.
	 */
	activityBroadcastsPerUserMinute: number;
	roomListRequestsPerUserMinute: number;
	/** The longest typing indicator a relayed `activity` may ask for, in seconds. */
	activityMaxTypingSeconds: number;
	/**
	 * Frames one connection reserves at once. Each reservation's SQL
	 * bookkeeping (about 24 reserved writes) is then shared by the block;
	 * operations that do SQL work still reserve their own cost. An unspent
	 * block is burned when the connection closes or the UTC day ends.
	 */
	frameLease: number;
	/** Users listed as `members` of each room in a `room_list` result: those connected now. */
	roomListMembers: number;
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
	/** Distinct users whose reaction sets one message may carry. */
	reactionUsersPerMessage: number;
	/** Distinct emoji in one user's reaction set on one message. */
	reactionEmojisPerUser: number;
	dedupTtlSeconds: number;
	limiterRecordCap: number;
	maxCredentialBytes: number;
	maxChallengeBytes: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
	retentionSeconds: 86_400,
	cleanupSeconds: 3_600,
	challengeTtlSeconds: 120,
	sessionTtlSeconds: 12 * 60 * 60,
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
	globalFramesPerMinute: 300,
	activityBroadcastsPerUserMinute: 10,
	roomListRequestsPerUserMinute: 6,
	activityMaxTypingSeconds: 30,
	frameLease: 10,
	roomListMembers: 20,
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
	reactionUsersPerMessage: 32,
	reactionEmojisPerUser: 8,
	dedupTtlSeconds: 86_400,
	limiterRecordCap: 10_000,
	maxCredentialBytes: 16 * 1024,
	maxChallengeBytes: 16 * 1024,
});

// Calibrated implementation bounds remain explicit: raising a payload or parser
// bound requires rechecking its consumers. Resource ceilings below instead use
// the selected defaults, so changing a budget does not require editing it twice.
export const MAX_FRAME_BYTES = 16 * 1024;
export const MAX_TEXT_BYTES = 4 * 1024;
export const MAX_SNAPSHOT_BYTES = 8 * 1024;
export const MAX_JSON_DEPTH = 8;
export const MAX_JSON_NODES = 2_048;
export const MAX_REQUEST_ID_BYTES = 128;
export const MAX_NAME_CODE_POINTS = 80;
export const MAX_NAME_BYTES = 320;
export const MAX_EMBEDS = 4;
export const MAX_HISTORY_LIMIT = 50;
export const MAX_HISTORY_RESPONSE_BYTES = 256 * 1024;
export const MAX_PENDING_FRAMES = 8;
export const MAX_PENDING_BYTES = 128 * 1024;
export const MAX_CONCURRENT_HISTORY = 1;
export const MAX_CREDENTIAL_BYTES = 16 * 1024;
export const MAX_CHALLENGE_BYTES = 16 * 1024;
export const MAX_OPEN_CONNECTIONS = DEFAULT_LIMITS.openConnections;
export const MAX_REGISTERED_IDENTITIES = DEFAULT_LIMITS.registeredIdentityCount;
export const MAX_LIMITER_RECORDS = DEFAULT_LIMITS.limiterRecordCap;
export const MAX_PROCESSED_FRAMES = DEFAULT_LIMITS.processedFramesPerDay;
export const MAX_GLOBAL_POSTS_PER_MINUTE = DEFAULT_LIMITS.globalPostsPerMinute;
export const MAX_GLOBAL_POSTS_PER_DAY = DEFAULT_LIMITS.globalPostsPerDay;
export const MAX_REGISTRATIONS_PER_DAY = DEFAULT_LIMITS.registrationsPerDay;
export const MAX_CLEANUP_BATCH = 100;
export const MAX_THREAD_LIMIT = 100;
export const MAX_THREAD_METADATA_BYTES = 2 * 1024;
// A move re-logs every reaction set of the moved message in one record, so the
// per-message cap bounds that record, its SQL work, and its history response.
export const MAX_REACTION_USERS_PER_MESSAGE = 64;
export const MAX_REACTION_EMOJIS_PER_USER = 16;
export const MAX_EMOJI_BYTES = 64;
export const MAX_CONNECTION_FRAME_RATE = 120;
// The server-wide frame window is one in-memory timestamp per frame.
export const MAX_GLOBAL_FRAMES_PER_MINUTE = 1_000;
// Throttle windows live in connection attachments, one timestamp per event.
export const MAX_TYPE_THROTTLE_PER_MINUTE = 60;
// A block counts against the IP's frame minute all at once.
export const MAX_FRAME_LEASE = 20;
// Every room in a listing carries the members list, so it multiplies the
// response by the thread ceiling.
export const MAX_ROOM_LIST_MEMBERS = 50;
export const MAX_SQL_WRITES = DEFAULT_LIMITS.sqlWritesPerDay;
export const MAX_SQL_READS = DEFAULT_LIMITS.sqlReadsPerDay;
export const MAX_DATABASE_HIGH_WATER_BYTES = DEFAULT_LIMITS.databaseHighWaterBytes;
export const MAX_DATABASE_HARD_TARGET_BYTES = DEFAULT_LIMITS.databaseHardTargetBytes;
export const MAINTENANCE_CONTROL_RESERVE = 8;
export const BOOTSTRAP_ROW_RESERVATION = 512;
export const MAX_SOCKET_QUEUE_ALLOCATION = 32 * 1024 * 1024;
// Attempts are counted before the Durable Object, including its later rejections.
// This is an approximate, per-Cloudflare-location limiter, not a billing cap.
export const ADMISSION_BUDGET = Object.freeze({
	requestsPerIpMinute: 10,
	workerWindowSeconds: 60,
	// Free WAF supports only 10-second windows; this optional rule is zone-wide.
	edgeRequestsPerIpWindow: 10,
	edgeWindowSeconds: 10,
	edgeBlockSeconds: 10,
});

// Account analytics are a delayed safety signal, not an exact quota meter.
// Keep this policy separate from local application reservations: a refresh can
// only stop this object after Cloudflare reports that the account is nearing a
// shared allowance.
export const ACCOUNT_USAGE_POLICY = Object.freeze({
	refreshEveryEvents: 1_000,
	minimumRefreshIntervalMs: 60_000,
	staleAfterMs: 5 * 60_000,
	initialRetryMs: 60_000,
	maxRetryMs: 15 * 60_000,
	stopRatio: 0.90,
	freeDaily: Object.freeze({
		workerRequests: 100_000,
		durableObjectRequests: 100_000,
		durableObjectDurationGbSeconds: 13_000,
		sqlRowsRead: 5_000_000,
		sqlRowsWritten: 100_000,
	}),
	freeStoredBytes: 5 * 1024 * 1024 * 1024,
});
