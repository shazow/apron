import { expect, test } from '@playwright/test';

// This exercises browser-generated credentials and the actual Workers verifier.
// Runtime/storage policy cases live in servers/cloudflare-worker/test.
test('Worker verifies discoverable passkeys, rejects replay and bad signatures, and restores identity', async ({ page, context }) => {
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
		protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
		hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true
	} });
	// An actual inert same-origin resource establishes localhost's address space
	// without starting the frontend's extra anonymous protocol socket.
	await page.goto('/robots.txt');
	await page.evaluate(async () => {
		const state = window as any;
		state.frames = [];
		state.sequence = 0;
		state.pending = new Map();
		state.connect = async () => {
			state.socket = new WebSocket('ws://localhost:8788/ws');
			await new Promise<void>((resolve, reject) => {
				state.socket.onerror = () => reject(new Error('WebSocket connection failed'));
				state.socket.onmessage = (event: MessageEvent) => {
					const frame = JSON.parse(event.data);
					state.frames.push(frame);
					if (frame.id && state.pending.has(frame.id)) {
						state.pending.get(frame.id)(frame);
						state.pending.delete(frame.id);
					}
					if (frame.method === 'server') resolve();
				};
			});
		};
		state.request = (method: string, params: unknown) => new Promise(resolve => {
			const id = `browser-${++state.sequence}`;
			state.pending.set(id, resolve);
			state.socket.send(JSON.stringify({ id, method, params }));
		});
		state.passkey = async (action: 'register' | 'login') => {
			const begin = await state.request('auth', { scheme: 'webauthn', action, step: 'begin' });
			if (begin.error) return begin;
			const json = begin.result.public_key;
			const credential = action === 'register'
				? await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(json) })
				: await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(json) });
			state.lastFinish = { scheme: 'webauthn', action, step: 'finish', challenge_id: begin.result.challenge_id,
				credential: (credential as PublicKeyCredential).toJSON() };
			return state.request('auth', state.lastFinish);
		};
		await state.connect();
	});
	const guest = await page.evaluate(() => (window as any).request('auth', { scheme: 'anonymous' }));
	expect(guest.result.you.user_id).toBeTruthy();
	const registered = await page.evaluate(() => (window as any).passkey('register'));
	expect(registered.error).toBeUndefined();
	expect(registered.result.you.user_id).not.toBe(guest.result.you.user_id);
	const userId = registered.result.you.user_id;
	const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
	expect(credentials).toHaveLength(1);
	expect(credentials[0].isResidentCredential).toBe(true);
	const posted = await page.evaluate(() => (window as any).request('message', { room_id: 'general', body: { text: 'passkey owner' } }));
	expect(posted.result.message_id).toBeTruthy();
	await page.evaluate(async () => {
		const state = window as any;
		await new Promise<void>(resolve => { state.socket.onclose = () => resolve(); state.socket.close(); });
		await state.connect();
	});
	const replay = await page.evaluate(() => (window as any).request('auth', (window as any).lastFinish));
	expect(replay.error.code).toBe(-32001);
	await cdp.send('WebAuthn.setResponseOverrideBits', { authenticatorId, isBogusSignature: true });
	const forged = await page.evaluate(() => (window as any).passkey('login'));
	expect(forged.error.code).toBe(-32001);
	await cdp.send('WebAuthn.setResponseOverrideBits', { authenticatorId, isBogusSignature: false });
	const login = await page.evaluate(() => (window as any).passkey('login'));
	expect(login.error).toBeUndefined();
	expect(login.result.you.user_id).toBe(userId);
	const edit = await page.evaluate(message_id => (window as any).request('message', {
		room_id: 'general', message_id, body: { text: 'verified returning owner' }
	}), posted.result.message_id);
	expect(edit.result.message_id).toBe(posted.result.message_id);
	const history = await page.evaluate(() => (window as any).request('history', { room_id: 'general', after: '0' }));
	expect(history.result.history_floor).toBe('1');
	expect(history.result.entries.at(-1).message.body.text).toBe('verified returning owner');
	await page.evaluate(() => (window as any).socket.close());
});

test('built frontend connects to the Worker and recovers retained history', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByTestId('connection-status')).toHaveText('Connected');
	await expect(page.getByText('This demo keeps roughly the last day of history; older messages may expire.')).toBeVisible();
	await expect(page.getByLabel('Loading history', { exact: true })).toHaveCount(0);
	const message = `worker-ui-${Date.now()}`;
	await page.getByRole('textbox', { name: 'Message', exact: true }).fill(message);
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('article[data-message-id]').filter({ hasText: message })).toBeVisible();
});
