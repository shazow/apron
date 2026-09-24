import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient } from './client';
import { FakeSocket, settle } from './fake-socket';
import { requestPasskey } from './webauthn';

vi.mock('./webauthn', () => ({ requestPasskey: vi.fn() }));

describe('passkey ceremonies carry a chosen handle', () => {
	beforeEach(() => {
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
		vi.mocked(requestPasskey).mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function ceremony(socket: FakeSocket, pending: Promise<unknown>, you: Record<string, unknown>): Promise<void> {
		await socket.reply('auth', { challenge_id: 'challenge-1', public_key: { challenge: 'x' } });
		await socket.reply('auth', { you });
		await pending;
	}

	it('applies a handle a guest could not set once registration signs them in', async () => {
		vi.mocked(requestPasskey).mockResolvedValue({ id: 'credential' });
		const client = new ChatClient('ws://fake.test/');
		client.start();
		const socket = FakeSocket.latest();
		await socket.greet([], { auth: ['webauthn', 'guest'] });
		expect(socket.sent.some((frame) => frame.method === 'me')).toBe(false);

		const pending = client.usePasskey('register', ' shazow ');
		await settle();
		expect(socket.request('auth').params).toEqual(expect.objectContaining({ action: 'register', step: 'begin' }));
		await ceremony(socket, pending, { user_id: 'u_1', name: 'Guest' });
		const named = await pending;
		expect(named).toBeDefined();
		expect(socket.request('me').params).toEqual({ name: 'shazow' });
		await socket.reply('me', { you: { user_id: 'u_1', name: 'shazow' } });
		await expect(named!.promise).resolves.toEqual({ you: { user_id: 'u_1', name: 'shazow' } });
		client.stop();
	});

	it('keeps the old handle when the ceremony is cancelled', async () => {
		vi.mocked(requestPasskey).mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'));
		const client = new ChatClient('ws://fake.test/');
		client.start();
		const socket = FakeSocket.latest();
		await socket.greet([], { auth: ['webauthn', 'guest'] });
		const pending = client.usePasskey('register', 'shazow');
		await settle();
		await socket.reply('auth', { challenge_id: 'challenge-1', public_key: { challenge: 'x' } });
		await expect(pending).rejects.toThrow('cancelled');
		expect(socket.sent.some((frame) => frame.method === 'me')).toBe(false);

		// A later sign-in without a chosen handle does not pick up the cancelled one.
		vi.mocked(requestPasskey).mockResolvedValue({ id: 'credential' });
		const login = client.usePasskey('login');
		await settle();
		await ceremony(socket, login, { user_id: 'u_2', name: 'Existing' });
		await expect(login).resolves.toBeUndefined();
		expect(socket.sent.some((frame) => frame.method === 'me')).toBe(false);
		client.stop();
	});
});
