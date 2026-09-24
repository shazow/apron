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

/** Return the browser option object from the canonical server envelope. */
export function passkeyPublicKeyOptions(options: JsonObject): JsonObject | undefined {
	if (isJsonObject(options.public_key)) return options.public_key;
	return undefined;
}

/**
 * How a login asks for a passkey: `modal` is the browser's sign-in sheet,
 * `conditional` offers passkeys in the autofill of a field marked
 * `autocomplete="username webauthn"`, and `immediate` shows the sheet only
 * when this device already holds a passkey for the site, failing at once with
 * `NotAllowedError` otherwise.
 */
export type PasskeyMediation = 'modal' | 'conditional' | 'immediate';

let conditionalSupport: Promise<boolean> | undefined;
let immediateSupport: Promise<boolean> | undefined;

/** Whether this browser offers passkeys in form autofill (conditional mediation). */
export function conditionalPasskeysAvailable(): Promise<boolean> {
	conditionalSupport ??= (async () => {
		if (passkeySupportError() || !PublicKeyCredential.isConditionalMediationAvailable) return false;
		return (await PublicKeyCredential.isConditionalMediationAvailable()) === true;
	})().catch(() => false);
	return conditionalSupport;
}

/** Whether this browser can ask for an existing passkey without prompting when there is none. */
export function immediatePasskeysAvailable(): Promise<boolean> {
	immediateSupport ??= (async () => {
		if (passkeySupportError()) return false;
		const capabilities = (PublicKeyCredential as unknown as {
			getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
		}).getClientCapabilities;
		if (!capabilities) return false;
		return (await capabilities.call(PublicKeyCredential)).immediateGet === true;
	})().catch(() => false);
	return immediateSupport;
}

/** The wire uses WebAuthn JSON encodings (base64url for binary fields). */
export async function requestPasskey(
	action: 'register' | 'login', options: JsonObject, signal: AbortSignal, mediation: PasskeyMediation = 'modal'
): Promise<JsonObject> {
	const unsupported = passkeySupportError();
	if (unsupported) throw new Error(unsupported);
	const publicKey = passkeyPublicKeyOptions(options);
	if (!publicKey) throw new Error('Invalid passkey options from server');
	const credential = action === 'register'
		? await navigator.credentials.create({
			publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(publicKey as unknown as PublicKeyCredentialCreationOptionsJSON), signal
		})
		: await navigator.credentials.get({
			publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(publicKey as unknown as PublicKeyCredentialRequestOptionsJSON), signal,
			// `immediate` is newer than the DOM typings.
			...(mediation === 'modal' ? {} : { mediation: mediation as CredentialMediationRequirement })
		});
	if (!(credential instanceof PublicKeyCredential)) throw new Error('No passkey was selected');
	return credential.toJSON() as unknown as JsonObject;
}
