/** The durable/runtime boundary shared by the WebSocket server and SQLite store. */

export type AuthTier = "pending" | "anonymous" | "registered";

export interface Identity {
	user_id: string;
	name?: string;
	tier?: "anonymous" | "registered";
}

export interface RoomState {
	roomId: "general";
	latestId: bigint;
	historyFloor: bigint;
	threads: ThreadRecord[];
}

export interface ThreadRecord {
	threadId: string;
	title?: string;
	summary?: string;
	rootMessageId?: string;
}

export interface ThreadMetadata {
	thread_id: string;
	title?: string;
	summary?: string;
	root_message_id?: string;
}

export interface StoredCredential {
	credentialId: string;
	userId: string;
	publicKey: string;
	counter: number;
	deviceType?: string;
	backedUp?: boolean;
	transports?: string[];
}

export interface StoredIdentity {
	userId: string;
	name: string;
	userHandle: string;
	credentialCount: number;
}

export interface DedupRecord {
	userId: string;
	requestId: string;
	digest: string;
	method: string;
	result: Record<string, unknown>;
	expiresAt: number;
}

export interface MutationInput {
	userId: string;
	ipKey: string;
	tier?: "anonymous" | "registered";
	requestId?: string;
	method: "message" | "thread" | "nick" | string;
	roomId?: string;
	now: number;
	messageId?: string;
	message?: Record<string, unknown>;
	body?: Record<string, unknown>;
	threadId?: string;
	replyMessageId?: string;
	deleted?: boolean;
	thread?: {
		threadId?: string;
		title?: string;
		summary?: string;
		rootMessageId?: string;
	};
	/** Complete request parameters, used for canonical replacement semantics. */
	params: Record<string, unknown>;
	identity: Identity;
	digest?: string;
}

export interface MutationCommit {
	messageId?: string;
	logId?: string;
	message?: Record<string, unknown>;
	result: Record<string, unknown>;
	/** Existing accepted request, so no broadcast is sent. */
	deduplicated?: boolean;
}

export interface HistoryQuery {
	roomId: "general";
	after?: bigint;
	before?: bigint;
	limit?: number;
	threadId?: string;
	maxBytes?: number;
	now?: number;
	userId?: string;
	ipKey?: string;
}

export interface HistoryEntry {
	log_id: string;
	message: Record<string, unknown>;
}

export interface HistoryPage {
	entries: HistoryEntry[];
	first_id?: string;
	last_id?: string;
	more: boolean;
	latest_log_id: string;
	history_log_id: string | null;
}

export interface AdmissionSnapshot {
	openConnections: number;
	globalFrames: number;
	globalPosts: number;
}

export interface CleanupResult {
	changed: boolean;
	/** The next alarm deadline, if maintenance still has bounded work. */
	nextAt?: number;
}

export interface AuthStore {
	getCredential(credentialId: string): StoredCredential | null;
	getIdentity(userId: string): StoredIdentity | null;
	registerIdentity(input: {
		userId: string;
		name: string;
		userHandle: string;
		credential: StoredCredential;
		now: number;
		ipKey: string;
	}): StoredIdentity;
	updateCredentialCounter(credentialId: string, counter: number): void;
	countIdentities(): number;
}

export interface DemoStore extends AuthStore {
	initialize(): void;
	room(): RoomState;
	findDedup(userId: string, requestId: string, now: number): DedupRecord | null;
	commitMutation(input: MutationInput): MutationCommit;
	history(query: HistoryQuery): HistoryPage;
	createThread(input: MutationInput): MutationCommit;
	reserveFrames(input: { ipKey: string; now: number; count?: number }): void;
	reserveAuthAttempt(input: { ipKey: string; now: number }): void;
	reserveHistory(input: { userId: string; ipKey: string; now: number }): void;
	reserveConnection(input: { ipKey: string; tier: AuthTier; now: number }): void;
	releaseConnection(input: { ipKey: string; tier: AuthTier }): void;
	cleanup(now: number): CleanupResult;
	setAlarmTask(task: { kind: "auth" | "cleanup"; dueAt: number; connectionId?: string }): void;
}
