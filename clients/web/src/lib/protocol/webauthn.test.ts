import { afterEach, describe, expect, it, vi } from 'vitest';

/** A browser with passkeys whose `immediate` support is described by the arguments. */
function stubBrowser(reportsImmediate: boolean, acceptsImmediate: boolean): void {
	class FakeCredential {
		static parseCreationOptionsFromJSON = vi.fn();
		static parseRequestOptionsFromJSON = vi.fn();
		static isConditionalMediationAvailable = vi.fn(async () => true);
		static getClientCapabilities = vi.fn(async () => ({ immediateGet: reportsImmediate }));
		toJSON(): void {}
	}
	vi.stubGlobal('isSecureContext', true);
	vi.stubGlobal('PublicKeyCredential', FakeCredential);
	vi.stubGlobal('navigator', {
		credentials: {
			get: vi.fn(async (options: { mediation?: string }) => {
				if (options.mediation === 'immediate' && !acceptsImmediate) {
					throw new TypeError("Failed to read the 'mediation' property from 'CredentialRequestOptions'");
				}
				throw new DOMException('signal is aborted without reason', 'AbortError');
			})
		}
	});
}

async function freshModule(): Promise<typeof import('./webauthn')> {
	vi.resetModules();
	return import('./webauthn');
}

describe('immediate passkey support', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('is available when reported and the browser accepts the mediation value', async () => {
		stubBrowser(true, true);
		expect(await (await freshModule()).immediatePasskeysAvailable()).toBe(true);
	});

	it('is unavailable when reported but the mediation value is rejected', async () => {
		// Chrome 153 reports immediateGet yet rejects mediation: 'immediate'.
		stubBrowser(true, false);
		expect(await (await freshModule()).immediatePasskeysAvailable()).toBe(false);
	});

	it('is unavailable when not reported, without probing', async () => {
		stubBrowser(false, true);
		const webauthn = await freshModule();
		expect(await webauthn.immediatePasskeysAvailable()).toBe(false);
		expect(navigator.credentials.get).not.toHaveBeenCalled();
	});
});
