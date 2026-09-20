import { isJsonObject, type JsonObject } from './types';

export function passkeySupportError(): string | undefined {
	if (!globalThis.isSecureContext) return 'Passkeys require HTTPS or a localhost connection.';
	if (typeof PublicKeyCredential === 'undefined' ||
		!PublicKeyCredential.parseCreationOptionsFromJSON ||
		!PublicKeyCredential.parseRequestOptionsFromJSON ||
		!PublicKeyCredential.prototype.toJSON) {
		return 'This browser does not support passkeys. Try an up-to-date browser.';
	}
	return undefined;
}

/** Return the browser option object from either supported server envelope. */
export function passkeyPublicKeyOptions(options: JsonObject): JsonObject | undefined {
	if (isJsonObject(options.publicKey)) return options.publicKey;
	if (isJsonObject(options.public_key)) return options.public_key;
	return undefined;
}

/** The wire uses WebAuthn JSON encodings (base64url for binary fields). */
export async function requestPasskey(
	action: 'register' | 'login', options: JsonObject, signal: AbortSignal
): Promise<JsonObject> {
	const unsupported = passkeySupportError();
	if (unsupported) throw new Error(unsupported);
	// `webauthn.demo.v1` wraps browser JSON options as `public_key`, while the
	// existing Go example returns the WebAuthn library's `publicKey` field.
	// Accept both spellings at this adapter boundary and leave the credential
	// response in the browser's JSON serialization for the server verifier.
	const publicKey = passkeyPublicKeyOptions(options);
	if (!publicKey) throw new Error('Invalid passkey options from server');
	const credential = action === 'register'
		? await navigator.credentials.create({
			publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(publicKey as unknown as PublicKeyCredentialCreationOptionsJSON), signal
		})
		: await navigator.credentials.get({
			publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(publicKey as unknown as PublicKeyCredentialRequestOptionsJSON), signal
		});
	if (!(credential instanceof PublicKeyCredential)) throw new Error('No passkey was selected');
	return credential.toJSON() as unknown as JsonObject;
}
