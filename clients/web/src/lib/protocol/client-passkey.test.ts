import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient } from './client';
import { FakeSocket, settle } from './fake-socket';
import { conditionalPasskeysAvailable, immediatePasskeysAvailable, requestPasskey } from './webauthn';

vi.mock('./webauthn', () => ({
	requestPasskey: vi.fn(),
	conditionalPasskeysAvailable: vi.fn(),
	immediatePasskeysAvailable: vi.fn()
}));

const storage = new Map<string, string>();

beforeEach(() => {
	FakeSocket.instances = [];
	storage.clear();
	vi.stubGlobal('WebSocket', FakeSocket);
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, value),
		removeItem: (key: string) => void storage.delete(key)
	});
	vi.mocked(requestPasskey).mockReset();
	vi.mocked(conditionalPasskeysAvailable).mockResolvedValue(true);
	vi.mocked(immediatePasskeysAvailable).mockResolvedValue(false);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function connected(): Promise<{ client: ChatClient; socket: FakeSocket }> {
	const client = new ChatClient('ws://fake.test/');
	client.start();
	const socket = FakeSocket.latest();
	await socket.greet([], { auth: ['webauthn', 'guest'] });
	return { client, socket };
}

function authRequests(socket: FakeSocket): Array<Record<string, unknown>> {
	return socket.sent.filter((frame) => frame.method === 'auth').map((frame) => frame.params as Record<string, unknown>);
}

/** Answers a begin, lets the (mocked) browser respond, then answers the finish. */
async function ceremony(socket: FakeSocket, you: Record<string, unknown>, timeout?: number): Promise<void> {
	await settle();
	await socket.reply('auth', { challenge_id: 'challenge-1', public_key: { challenge: 'x', ...(timeout ? { timeout } : {}) } });
	await socket.reply('auth', { you });
}

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
};

describe('passkey ceremonies carry a chosen handle', () => {
	it('applies a handle a guest could not set once registration signs them in', async () => {
		vi.mocked(requestPasskey).mockResolvedValue({ id: 'credential' });
		const { client, socket } = await connected();
		expect(socket.sent.some((frame) => frame.method === 'me')).toBe(false);

		const pending = client.usePasskey('register', ' shazow ');
		await settle();
		expect(socket.request('auth').params).toEqual(expect.objectContaining({ action: 'register', step: 'begin' }));
		await ceremony(socket, { user_id: 'u_1', name: 'Guest' });
		const named = await pending;
		expect(named).toBeDefined();
		expect(socket.request('me').params).toEqual({ name: 'shazow' });
		await socket.reply('me', { you: { user_id: 'u_1', name: 'shazow' } });
		await expect(named!.promise).resolves.toEqual({ you: { user_id: 'u_1', name: 'shazow' } });
		client.stop();
	});

	it('keeps the old handle when the ceremony is cancelled', async () => {
		vi.mocked(requestPasskey).mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'));
		const { client, socket } = await connected();
		const pending = client.usePasskey('register', 'shazow');
		await settle();
		await socket.reply('auth', { challenge_id: 'challenge-1', public_key: { challenge: 'x' } });
		await expect(pending).rejects.toThrow('cancelled');
		expect(socket.sent.some((frame) => frame.method === 'me')).toBe(false);

		// A later sign-in without a chosen handle does not pick up the cancelled one.
		vi.mocked(requestPasskey).mockResolvedValue({ id: 'credential' });
		const login = client.usePasskey('login');
		await ceremony(socket, { user_id: 'u_2', name: 'Existing' });
		await expect(login).resolves.toBeUndefined();
		expect(socket.sent.some((frame) => frame.method === 'me')).toBe(false);
		client.stop();
	});
});

describe('passkey ceremonies and requests in flight', () => {
	const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	it('waits for requests sent as the old identity before starting', async () => {
		vi.mocked(requestPasskey).mockResolvedValue({ id: 'credential' });
		const { client, socket } = await connected();
		client.setDisplayName('Renamed');
		const pending = client.usePasskey('login');
		await pause(120);
		expect(authRequests(socket).some((params) => params.scheme === 'webauthn')).toBe(false);
		await socket.reply('me', { you: { user_id: 'guest_1', name: 'Renamed' } });
		await pause(120);
		expect(socket.request('auth').params).toEqual(expect.objectContaining({ action: 'login', step: 'begin' }));
		await ceremony(socket, { user_id: 'u_1', name: 'Existing' });
		await expect(pending).resolves.toBeDefined();
		client.stop();
	});
});

describe('continue with passkey', () => {
	it('signs in when immediate mediation finds a passkey on this device', async () => {
		vi.mocked(immediatePasskeysAvailable).mockResolvedValue(true);
		vi.mocked(requestPasskey).mockResolvedValue({ id: 'credential' });
		const { client, socket } = await connected();
		expect(await client.passkeyPlan()).toBe('immediate');
		const pending = client.continueWithPasskey();
		await ceremony(socket, { user_id: 'u_1', name: 'Existing' });
		await expect(pending).resolves.toEqual({ action: 'login', named: undefined });
		expect(vi.mocked(requestPasskey).mock.calls[0]?.[3]).toBe('immediate');
		expect(authRequests(socket).filter((params) => params.step === 'begin').map((params) => params.action)).toEqual(['login']);
		client.stop();
	});

	it('registers a new passkey when immediate mediation finds none', async () => {
		vi.mocked(immediatePasskeysAvailable).mockResolvedValue(true);
		vi.mocked(requestPasskey)
			.mockRejectedValueOnce(new DOMException('none', 'NotAllowedError'))
			.mockResolvedValueOnce({ id: 'credential' });
		const { client, socket } = await connected();
		const pending = client.continueWithPasskey('shazow');
		await settle();
		await socket.reply('auth', { challenge_id: 'challenge-1', public_key: { challenge: 'x' } });
		await ceremony(socket, { user_id: 'u_1', name: 'Guest' });
		const result = await pending;
		expect(result.action).toBe('register');
		expect(authRequests(socket).filter((params) => params.step === 'begin').map((params) => params.action)).toEqual(['login', 'register']);
		expect(socket.request('me').params).toEqual({ name: 'shazow' });
		client.stop();
	});

	it('falls back to registering when the browser rejects immediate mediation as an option', async () => {
		vi.mocked(immediatePasskeysAvailable).mockResolvedValue(true);
		vi.mocked(requestPasskey)
			.mockRejectedValueOnce(new TypeError("Failed to read the 'mediation' property"))
			.mockResolvedValueOnce({ id: 'credential' });
		const { client, socket } = await connected();
		const pending = client.continueWithPasskey();
		await settle();
		await socket.reply('auth', { challenge_id: 'challenge-1', public_key: { challenge: 'x' } });
		await ceremony(socket, { user_id: 'u_1', name: 'Guest' });
		await expect(pending).resolves.toEqual(expect.objectContaining({ action: 'register' }));
		expect(vi.mocked(requestPasskey).mock.calls.map((call) => [call[0], call[3]])).toEqual([['login', 'immediate'], ['register', 'modal']]);
		client.stop();
	});

	it('without immediate mediation, registers until this browser has used a passkey here, then signs in', async () => {
		vi.mocked(requestPasskey).mockResolvedValue({ id: 'credential' });
		const { client, socket } = await connected();
		expect(await client.passkeyPlan()).toBe('register');
		const first = client.continueWithPasskey();
		await ceremony(socket, { user_id: 'u_1', name: 'Guest' });
		await expect(first).resolves.toEqual(expect.objectContaining({ action: 'register' }));
		expect(storage.get('apron.passkey:ws://fake.test/')).toBe('1');
		client.stop();

		// The hint survives sign-out and reloads: the passkey is still on the device.
		const next = new ChatClient('ws://fake.test/');
		expect(await next.passkeyPlan()).toBe('login');
	});
});

describe('passkey autofill', () => {
	it('signs in when the user picks a passkey from autofill', async () => {
		const picked = deferred<Record<string, unknown>>();
		vi.mocked(requestPasskey).mockReturnValueOnce(picked.promise as never);
		const { client, socket } = await connected();
		const controller = new AbortController();
		const pending = client.passkeyAutofill(controller.signal, () => 'shazow');
		await settle();
		await socket.reply('auth', { challenge_id: 'challenge-1', public_key: { challenge: 'x' } });
		expect(vi.mocked(requestPasskey).mock.calls[0]?.[3]).toBe('conditional');
		picked.resolve({ id: 'credential' });
		await settle();
		await socket.reply('auth', { you: { user_id: 'u_1', name: 'Existing' } });
		const result = await pending;
		expect(result?.named).toBeDefined();
		expect(socket.request('me').params).toEqual({ name: 'shazow' });
		client.stop();
	});

	it('re-issues the challenge before it expires', async () => {
		vi.useFakeTimers();
		vi.mocked(requestPasskey).mockImplementation((_action, _options, signal) => new Promise((_resolve, reject) => {
			signal.addEventListener('abort', () => reject(signal.reason));
		}));
		const { client, socket } = await connected();
		const controller = new AbortController();
		const pending = client.passkeyAutofill(controller.signal);
		await settle();
		await socket.reply('auth', { challenge_id: 'challenge-1', public_key: { challenge: 'x', timeout: 60_000 } });
		expect(authRequests(socket).filter((params) => params.step === 'begin')).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(50_000);
		expect(authRequests(socket).filter((params) => params.step === 'begin')).toHaveLength(2);
		controller.abort();
		await socket.reply('auth', { challenge_id: 'challenge-2', public_key: { challenge: 'y' } });
		await expect(pending).resolves.toBeUndefined();
		client.stop();
	});

	it('steps aside for an explicit ceremony', async () => {
		vi.mocked(requestPasskey).mockImplementationOnce((_action, _options, signal) => new Promise((_resolve, reject) => {
			signal.addEventListener('abort', () => reject(signal.reason));
		}));
		const { client, socket } = await connected();
		const autofill = client.passkeyAutofill(new AbortController().signal);
		await settle();
		await socket.reply('auth', { challenge_id: 'challenge-1', public_key: { challenge: 'x' } });

		vi.mocked(requestPasskey).mockResolvedValueOnce({ id: 'credential' });
		const explicit = client.usePasskey('register');
		await expect(autofill).resolves.toBeUndefined();
		await ceremony(socket, { user_id: 'u_1', name: 'Guest' });
		await expect(explicit).resolves.toBeUndefined();
		expect(vi.mocked(requestPasskey).mock.calls.map((call) => call[3])).toEqual(['conditional', 'modal']);
		client.stop();
	});

	it('does nothing where the browser has no passkey autofill', async () => {
		vi.mocked(conditionalPasskeysAvailable).mockResolvedValue(false);
		const { client, socket } = await connected();
		await expect(client.passkeyAutofill(new AbortController().signal)).resolves.toBeUndefined();
		expect(authRequests(socket).some((params) => params.scheme === 'webauthn')).toBe(false);
		client.stop();
	});
});
