import { describe, expect, it } from 'vitest';
import { reconnectDelay, recoveryBufferFits } from './client';
import type { Transition } from './types';

const transition: Transition = {
	log_id: '1724803200001',
	message: { message_id: '1724803200001', from: { user_id: 'alice' }, body: { text: 'live' } }
};

describe('client recovery policies', () => {
	it('rejects a recovery buffer at either configured bound', () => {
		expect(recoveryBufferFits(999, 0, transition, 1000, 1_000_000)).toBe(true);
		expect(recoveryBufferFits(1000, 0, transition, 1000, 1_000_000)).toBe(false);
		expect(recoveryBufferFits(0, 999, transition, 1000, 1000)).toBe(false);
	});

	it('adds jitter while honoring a server retry delay', () => {
		expect(reconnectDelay(1, 0, 700)).toBe(700);
		expect(reconnectDelay(2, 0, 0)).toBe(800);
		expect(reconnectDelay(2, 1, 0)).toBe(1200);
	});
});
