/** The durable/runtime boundary shared by the WebSocket server and SQLite store. */

export type AuthTier = "pending" | "anonymous" | "registered";

export interface Identity {
	user_id: string;
	name?: string;
	/** Internal quota tier. The wire name of the `anonymous` tier is `guest`. */
	tier?: "anonymous" | "registered";
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
