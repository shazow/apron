import { describe, expect, it } from 'vitest';
import historyFloor from '../../../../../tests/fixtures/extensions/history_floor.v1.json';
import webAuthn from '../../../../../tests/fixtures/extensions/webauthn.demo.v1.json';
import { passkeyPublicKeyOptions } from './webauthn';
import { isLogId } from './types';

describe('Cloudflare demo extension fixtures', () => {
	it('keeps history_floor cases versioned and uses decimal log boundaries', () => {
		expect(historyFloor.format).toBe(1);
		expect(historyFloor.extension).toBe('history_floor.v1');
		expect(historyFloor.version).toBe(1);
		for (const scenario of historyFloor.cases) {
			if (scenario.floor) expect(isLogId(scenario.floor)).toBe(true);
			if (scenario.checkpoint) expect(isLogId(scenario.checkpoint)).toBe(true);
		}
	});

	it('adapts snake_case public_key options used by webauthn.demo.v1', () => {
		const registration = webAuthn.cases[0];
		const options = passkeyPublicKeyOptions(registration.begin_result);
		expect(options).toEqual(registration.begin_result.public_key);
		expect(registration.begin.params).toMatchObject({ scheme: 'webauthn', action: 'register', step: 'begin' });
		expect(registration.finish?.params).toMatchObject({ scheme: 'webauthn', action: 'register', step: 'finish', challenge_id: registration.begin_result.challenge_id });
	});
});
