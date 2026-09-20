import { describe, expect, it } from 'vitest';
import historyFixture from '../../../../../tests/fixtures/history.json';
import webAuthn from '../../../../../tests/fixtures/extensions/webauthn.demo.v1.json';
import { passkeyPublicKeyOptions } from './webauthn';
import { isLogId } from './types';

describe('Base history fixtures', () => {
	it('uses nullable room-wide boundaries and includes both bounds on history results', () => {
		expect(historyFixture.format).toBe(1);
		expect(historyFixture.kind).toBe('history');
		for (const scenario of historyFixture.cases) {
			if (!scenario.room) continue;
			const roomParams = scenario.room.params;
			expect(roomParams.latest_log_id === '0' || isLogId(roomParams.latest_log_id)).toBe(true);
			expect(Object.hasOwn(roomParams, 'history_log_id')).toBe(true);
			if (roomParams.history_log_id !== null) expect(isLogId(roomParams.history_log_id)).toBe(true);

			if (!scenario.history) continue;
			const result = scenario.history.result;
			expect(result.latest_log_id).toBe(roomParams.latest_log_id);
			expect(Object.hasOwn(result, 'history_log_id')).toBe(true);
			if (result.history_log_id !== null) expect(isLogId(result.history_log_id)).toBe(true);
		}
	});
});

describe('WebAuthn extension fixtures', () => {
	it('adapts snake_case public_key options used by webauthn.demo.v1', () => {
		const registration = webAuthn.cases[0];
		const options = passkeyPublicKeyOptions(registration.begin_result);
		expect(options).toEqual(registration.begin_result.public_key);
		expect(registration.begin.params).toMatchObject({ scheme: 'webauthn', action: 'register', step: 'begin' });
		expect(registration.finish?.params).toMatchObject({ scheme: 'webauthn', action: 'register', step: 'finish', challenge_id: registration.begin_result.challenge_id });
	});
});
