import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultWebSocketUrl, normalizeWebSocketUrl, reconnectDelay, recoveryBufferFits } from './client';
import type { Transition } from './types';

const transition: Transition = {
	log_id: '1724803200001',
	message: { message_id: '1724803200001', from: { user_id: 'alice' }, body: { text: 'live' } }
};

describe('default server URL', () => {
	afterEach(() => vi.unstubAllEnvs());
	const location = new URL('https://web.apron.chat/') as unknown as Location;

	it('uses the configured backend while preserving an explicit server choice', () => {
		vi.stubEnv('VITE_DEFAULT_SERVER_URL', 'wss://server.apron.chat/');
		expect(defaultWebSocketUrl(location)).toBe('wss://server.apron.chat/');
		expect(normalizeWebSocketUrl('', location)).toBe('wss://server.apron.chat/');
		expect(normalizeWebSocketUrl('https://other.example', location)).toBe('wss://other.example/');
	});

	it('keeps same-origin and local defaults without deployment configuration', () => {
		vi.stubEnv('VITE_DEFAULT_SERVER_URL', '');
		expect(defaultWebSocketUrl(location)).toBe('wss://web.apron.chat/ws');
		expect(defaultWebSocketUrl(new URL('http://localhost:5173') as unknown as Location)).toBe('ws://localhost:5173/ws');
		expect(defaultWebSocketUrl()).toBe('ws://localhost:8080/ws');
	});

	it('preserves root URLs and explicit paths rather than appending a socket path', () => {
		for (const input of ['wss://server.apron.chat', 'wss://server.apron.chat/', 'https://server.apron.chat']) {
			expect(normalizeWebSocketUrl(input, location)).toBe('wss://server.apron.chat/');
		}
		expect(normalizeWebSocketUrl('localhost:8080')).toBe('ws://localhost:8080/');
		expect(normalizeWebSocketUrl('wss://other.example/ws?room=general')).toBe('wss://other.example/ws?room=general');
		expect(normalizeWebSocketUrl('/', location)).toBe('wss://web.apron.chat/');
	});
});

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
