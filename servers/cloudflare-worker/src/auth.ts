import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
	type WebAuthnCredential,
} from "@simplewebauthn/server";
import type { RuntimeConfig } from "./config";
import type { Identity, StoredCredential } from "./domain";

export type WebAuthnAction = "register" | "login";

export interface ChallengeRecord {
	challengeId: string;
	action: WebAuthnAction;
	challenge: string;
	origin: string;
	rpId: string;
	/** Connection and proposed identity bindings are checked again at finish. */
	connectionId?: string;
	identityUserId?: string | null;
	userId?: string;
	userHandle?: string;
	userName?: string;
	expiresAt: number;
}

export interface CredentialRepository {
	getCredential(credentialId: string): StoredCredential | null | Promise<StoredCredential | null>;
	getIdentity?(userId: string): Identity | null | Promise<Identity | null>;
	registerCredential(input: {
		userId: string;
		name: string;
		userHandle: string;
		credential: StoredCredential;
		ipKey: string;
		now: number;
	}): Identity | Promise<Identity>;
	updateCredentialCounter(credentialId: string, counter: number): void | Promise<void>;
}

export interface AuthIdentity extends Identity {
	tier: "registered";
}

export interface BeginResult {
	challenge: ChallengeRecord;
	publicKey: Record<string, unknown>;
}

export interface FinishResult {
	identity: AuthIdentity;
	credential?: StoredCredential;
}

/**
 * A ceremony failure is deliberately indistinguishable from a missing or
 * unusable credential at the protocol boundary.  In particular, the
 * SimpleWebAuthn verifier may throw for malformed client data or a bad
 * signature rather than returning `{ verified: false }`.
 */
export class AuthError extends Error {
	constructor(message = "Passkey verification failed") {
		super(message);
		this.name = "denied";
	}
}

export class AuthTooLargeError extends AuthError {
	constructor(message = "Passkey credential is too large") {
		super(message);
		this.name = "too_large";
	}
}

function randomBase64Url(bytes = 24): string {
	const raw = new Uint8Array(bytes);
	crypto.getRandomValues(raw);
	let binary = "";
	for (const byte of raw) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw new Error("credential id is malformed");
	const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function bytesToBase64Url(value: Uint8Array): string {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function serializedBytes(value: unknown): number {
	const serialized = JSON.stringify(value);
	return serialized === undefined ? Number.POSITIVE_INFINITY : new TextEncoder().encode(serialized).byteLength;
}

function normalizedCredentialId(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 1024) throw new Error("credential id is invalid");
	if (bytesToBase64Url(base64UrlToBytes(value)) !== value) throw new Error("credential id is not canonical");
	return value;
}

function asCredentialResponse(value: unknown, maxBytes: number): RegistrationResponseJSON | AuthenticationResponseJSON {
	if (!isObject(value) || value.type !== "public-key") throw new AuthError("Passkey credential is invalid");
	const id = normalizedCredentialId(value.id);
	if (typeof value.rawId !== "string") throw new AuthError("Passkey credential is invalid");
	// The browser adapter serializes ArrayBuffers to base64url strings. Keep
	// rawId bounded and syntactically valid before handing it to the verifier.
	normalizedCredentialId(value.rawId);
	if (value.rawId !== id) throw new AuthError("Passkey credential is invalid");
	if (!isObject(value.response)) throw new AuthError("Passkey credential is invalid");
	if (serializedBytes(value) > maxBytes) throw new AuthTooLargeError();
	return { ...value, id } as RegistrationResponseJSON | AuthenticationResponseJSON;
}

/**
 * Discoverability is enforced by `residentKey: "required"` in the creation
 * options: a conforming client fails the ceremony rather than mint a
 * non-discoverable credential. The `credProps` extension output is optional
 * and many clients (Android, several password managers) omit it or leave
 * `rk` unset, so only an explicit `rk: false` is treated as a refusal.
 */
function reportsNonDiscoverableCredential(response: RegistrationResponseJSON | AuthenticationResponseJSON): boolean {
	if (!isObject(response.clientExtensionResults) || !isObject(response.clientExtensionResults.credProps)) return false;
	return response.clientExtensionResults.credProps.rk === false;
}

function toWebAuthnCredential(record: StoredCredential): WebAuthnCredential {
	return {
		id: record.credentialId,
		publicKey: base64UrlToBytes(record.publicKey),
		counter: record.counter,
		transports: record.transports,
	};
}

function identityWithTier(identity: Identity): AuthIdentity {
	return { user_id: identity.user_id, ...(identity.name ? { name: identity.name } : {}), tier: "registered" };
}

/** A bounded, stateless WebAuthn ceremony helper. Durable identity writes stay in the store. */
export class WebAuthnService {
	constructor(private readonly config: RuntimeConfig) {}

	async begin(
		action: WebAuthnAction,
		origin: string,
		now: number,
		identity?: Identity,
		existingCredentialIds: string[] = [],
		connectionId?: string,
	): Promise<BeginResult> {
		if (!this.config.rpOrigins.includes(origin)) throw new Error("origin is not configured for passkeys");
		if (action === "register" && identity?.tier === "registered") throw new Error("identity switching requires reconnect");
		const challengeId = randomBase64Url(18);
		const challenge = randomBase64Url(32);
		const candidateUserId = action === "register" ? `u_${randomBase64Url(16)}` : undefined;
		const candidateUserHandle = action === "register" ? randomBase64Url(16) : undefined;
		const candidateName = action === "register"
			? (identity?.name ?? `Guest ${randomBase64Url(4)}`.slice(0, Math.min(this.config.limits.maxNameCodePoints, this.config.limits.maxNameBytes)))
			: undefined;
		const options = action === "register"
			? await generateRegistrationOptions({
				rpName: this.config.rpName,
				rpID: this.config.rpId,
				userName: candidateUserId!,
				userDisplayName: candidateName!.slice(0, 80),
				userID: base64UrlToBytes(candidateUserHandle!),
				challenge,
				attestationType: "none",
				authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
				excludeCredentials: existingCredentialIds.slice(0, 10).map((id) => ({ id })),
				timeout: this.config.limits.challengeTtlSeconds * 1_000,
			})
			: await generateAuthenticationOptions({
				rpID: this.config.rpId,
				challenge,
				userVerification: "required",
				timeout: this.config.limits.challengeTtlSeconds * 1_000,
			});
		if (serializedBytes(options) > this.config.limits.maxChallengeBytes) throw new Error("generated passkey options are too large");
		return {
			challenge: {
				challengeId,
				action,
				challenge: options.challenge,
				origin,
				rpId: this.config.rpId,
				...(connectionId ? { connectionId } : {}),
				...(action === "register" ? { identityUserId: identity?.user_id ?? null } : {}),
				...(candidateUserId ? { userId: candidateUserId, userHandle: candidateUserHandle, userName: candidateName } : {}),
				expiresAt: now + this.config.limits.challengeTtlSeconds * 1_000,
			},
			publicKey: options as unknown as Record<string, unknown>,
		};
	}

	async finish(
		challenge: ChallengeRecord,
		challengeId: string,
		credentialValue: unknown,
		repository: CredentialRepository,
		input: { now: number; ipKey: string; identity?: Identity; connectionId?: string },
	): Promise<FinishResult> {
		if (challenge.challengeId !== challengeId || input.now >= challenge.expiresAt) throw new AuthError("Passkey challenge is missing or expired");
		if (challenge.connectionId !== undefined && challenge.connectionId !== input.connectionId) throw new AuthError("Passkey challenge is bound to another connection");
		if (Object.hasOwn(challenge, "identityUserId") && challenge.identityUserId !== (input.identity?.user_id ?? null)) throw new AuthError("Passkey registration identity changed");
		if (challenge.origin.length === 0 || !this.config.rpOrigins.includes(challenge.origin) || challenge.rpId !== this.config.rpId) {
			throw new AuthError("Passkey challenge binding is invalid");
		}
		if (serializedBytes(credentialValue) > this.config.limits.maxCredentialBytes) throw new AuthTooLargeError();
		let response: RegistrationResponseJSON | AuthenticationResponseJSON;
		try {
			response = asCredentialResponse(credentialValue, this.config.limits.maxCredentialBytes);
		} catch (error) {
			if (error instanceof AuthError) throw error;
			throw new AuthError("Passkey credential is invalid");
		}
		if (challenge.action === "register") {
			if (reportsNonDiscoverableCredential(response as RegistrationResponseJSON)) throw new AuthError("Passkey registration requires a discoverable credential");
			if (!challenge.userId || !challenge.userHandle || !challenge.userName) throw new AuthError("Passkey registration challenge is incomplete");
			let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
			try {
				verified = await verifyRegistrationResponse({
					response: response as RegistrationResponseJSON,
					expectedChallenge: challenge.challenge,
					expectedOrigin: challenge.origin,
					expectedRPID: challenge.rpId,
					requireUserPresence: true,
					requireUserVerification: true,
				});
			} catch {
				throw new AuthError();
			}
			if (!verified.verified || !verified.registrationInfo?.userVerified) throw new AuthError();
			const info = verified.registrationInfo;
			const credentialId = typeof info.credential.id === "string" ? info.credential.id : bytesToBase64Url(info.credential.id);
			const userId = challenge.userId;
			const stored = await repository.registerCredential({
				userId,
				name: challenge.userName,
				userHandle: challenge.userHandle,
				credential: {
					credentialId,
					userId,
					publicKey: bytesToBase64Url(info.credential.publicKey),
					counter: info.credential.counter,
					deviceType: info.credentialDeviceType,
					backedUp: info.credentialBackedUp,
				},
				ipKey: input.ipKey,
				now: input.now,
			});
			return { identity: identityWithTier(stored) };
		}
		const credentialId = normalizedCredentialId((response as AuthenticationResponseJSON).id);
		const stored = await repository.getCredential(credentialId);
		if (!stored) throw new AuthError();
		let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
		try {
			verified = await verifyAuthenticationResponse({
				response: response as AuthenticationResponseJSON,
				expectedChallenge: challenge.challenge,
				expectedOrigin: challenge.origin,
				expectedRPID: challenge.rpId,
				credential: toWebAuthnCredential(stored),
				requireUserVerification: true,
			});
		} catch {
			throw new AuthError();
		}
		if (!verified.verified || !verified.authenticationInfo.userVerified) throw new AuthError();
		const newCounter = verified.authenticationInfo.newCounter;
		// Synced passkeys may legitimately report zero/non-monotonic counters;
		// only persist a forward movement and leave the verifier's signature/UV
		// checks as the authenticity proof.
		if (newCounter > stored.counter) await repository.updateCredentialCounter(credentialId, newCounter);
		const identity = await repository.getIdentity?.(stored.userId) ?? { user_id: stored.userId };
		return {
			identity: identityWithTier(identity),
			credential: { ...stored, counter: Math.max(stored.counter, newCounter) },
		};
	}
}
