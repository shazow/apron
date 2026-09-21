import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { WebAuthnService, type ChallengeRecord, type CredentialRepository } from '../src/auth';
import { loadConfig } from '../src/config';
import { Store } from '../src/store';

const encode = (text: string) => new TextEncoder().encode(text);
const join = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) { result.set(part, offset); offset += part.length; }
	return result;
};
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const unb64 = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
const hash = async (bytes: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

// Minimal CBOR encoder for a genuine attestation-none cryptographic fixture.
// It is test data generation, not an alternate production WebAuthn verifier.
function cbor(value: number | string | Uint8Array | Map<number | string, any>): Uint8Array<ArrayBuffer> {
	const head = (major: number, size: number) => size < 24 ? new Uint8Array([major * 32 + size]) : new Uint8Array([major * 32 + 24, size]);
	if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
	if (typeof value === 'string') return join(head(3, encode(value).length), encode(value));
	if (value instanceof Uint8Array) return join(head(2, value.length), value);
	return join(head(5, value.size), ...Array.from(value, ([key, item]) => join(cbor(key), cbor(item))));
}

function derSignature(raw: Uint8Array): Uint8Array<ArrayBuffer> {
	const integer = (part: Uint8Array) => {
		while (part.length > 1 && part[0] === 0) part = part.slice(1);
		if (part[0] & 128) part = join(new Uint8Array([0]), part);
		return join(new Uint8Array([2, part.length]), part);
	};
	const content = join(integer(raw.slice(0, 32)), integer(raw.slice(32)));
	return join(new Uint8Array([0x30, content.length]), content);
}

it('verifies signed ceremonies against SQLite identities and rejects challenge, origin, RP, UV, signature and duplicate failures', async () => {
	await runInDurableObject(env.DEMO.getByName('auth-cryptographic-fixtures'), async (_instance, state) => {
		const now = Date.now() + 1_000;
		const store = new Store(state, {}, { now: () => now });
		const service = new WebAuthnService(loadConfig({
			ALLOWED_ORIGINS: 'https://chat.example.test', RP_ORIGINS: 'https://chat.example.test',
			RP_ID: 'example.test',
		}));
		const repository: CredentialRepository = {
			getCredential: id => store.getCredential(id),
			getIdentity: id => { const row = store.getIdentity(id); return row ? { user_id: row.userId, name: row.name } : null; },
			registerCredential: input => { const row = store.registerIdentity(input); return { user_id: row.userId, name: row.name }; },
			updateCredentialCounter: (id, counter) => store.updateCredentialCounter(id, counter),
		};
		const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
		const publicKey = await crypto.subtle.exportKey('jwk', key.publicKey);
		const credentialId = crypto.getRandomValues(new Uint8Array(32));
		const cose = cbor(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, unb64(publicKey.x!)], [-3, unb64(publicKey.y!)]]));
		const clientData = (challenge: ChallengeRecord, type: string, override: Record<string, string> = {}) => encode(JSON.stringify({
			type, challenge: challenge.challenge, origin: challenge.origin, ...override,
		}));
		const registration = async (challenge: ChallengeRecord) => {
			const authData = join(await hash(encode(challenge.rpId)), new Uint8Array([0x45, 0, 0, 0, 0]), new Uint8Array(16), new Uint8Array([0, credentialId.length]), credentialId, cose);
			return { id: b64(credentialId), rawId: b64(credentialId), type: 'public-key', response: {
				clientDataJSON: b64(clientData(challenge, 'webauthn.create')),
				attestationObject: b64(cbor(new Map<string, any>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))),
			}, clientExtensionResults: { credProps: { rk: true } } };
		};
		const begun = await service.begin('register', 'https://chat.example.test', now, { user_id: 'guest_original', name: 'Guest', tier: 'anonymous' });
		expect(begun.publicKey.authenticatorSelection).toMatchObject({ residentKey: 'required', requireResidentKey: true, userVerification: 'required' });
		const registered = await service.finish(begun.challenge, begun.challenge.challengeId, await registration(begun.challenge), repository, {
			now, ipKey: 'fixture-ip', identity: { user_id: 'guest_original', name: 'Guest', tier: 'anonymous' },
		});
		expect(registered.identity.tier).toBe('registered');
		expect(registered.identity.user_id).not.toBe('guest_original');
		expect(store.getIdentity(registered.identity.user_id)?.userHandle).toBe(begun.challenge.userHandle);
		const duplicate = await service.begin('register', 'https://chat.example.test', now);
		await expect(service.finish(duplicate.challenge, duplicate.challenge.challengeId, await registration(duplicate.challenge), repository, { now, ipKey: 'fixture-ip' })).rejects.toThrow();

		const login = await service.begin('login', 'https://chat.example.test', now);
		expect(login.publicKey.userVerification).toBe('required');
		expect(login.publicKey.allowCredentials === undefined || (Array.isArray(login.publicKey.allowCredentials) && login.publicKey.allowCredentials.length === 0)).toBe(true);
		const assertion = async (options: { flags?: number; rp?: string; client?: Record<string, string>; badSignature?: boolean } = {}) => {
			const data = clientData(login.challenge, 'webauthn.get', options.client);
			const authData = join(await hash(encode(options.rp ?? login.challenge.rpId)), new Uint8Array([options.flags ?? 5, 0, 0, 0, 1]));
			const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, join(authData, await hash(data))));
			if (options.badSignature) raw[0] ^= 1;
			return { id: b64(credentialId), rawId: b64(credentialId), type: 'public-key', response: {
				clientDataJSON: b64(data), authenticatorData: b64(authData), signature: b64(derSignature(raw)),
			}, clientExtensionResults: {} };
		};
		const finish = (response: unknown, time = now, challengeId = login.challenge.challengeId) => service.finish(login.challenge, challengeId, response, repository, { now: time, ipKey: 'fixture-ip' });
		const invalidAssertions: NonNullable<Parameters<typeof assertion>[0]>[] = [
			{ client: { challenge: 'different-challenge' } }, { client: { origin: 'https://evil.example.test' } },
			{ client: { type: 'webauthn.create' } }, { rp: 'evil.test' }, { flags: 1 }, { flags: 4 }, { badSignature: true },
		];
		for (const options of invalidAssertions) await expect(finish(await assertion(options))).rejects.toThrow('Passkey verification failed');
		await expect(finish(await assertion(), now, 'other-connection-challenge')).rejects.toThrow('challenge');
		await expect(finish(await assertion(), login.challenge.expiresAt)).rejects.toThrow('expired');
		await expect(finish({ response: 'x'.repeat(16_385) })).rejects.toThrow('too large');
		const accepted = await finish(await assertion());
		expect(accepted.identity.user_id).toBe(registered.identity.user_id);
		expect(store.getCredential(b64(credentialId))?.counter).toBe(1);

		const connectionBound = await service.begin('login', 'https://chat.example.test', now, undefined, [], 'connection-a');
		await expect(service.finish(connectionBound.challenge, connectionBound.challenge.challengeId, {}, repository, {
			now, ipKey: 'fixture-ip', connectionId: 'connection-b',
		})).rejects.toThrow('another connection');
	});
});
