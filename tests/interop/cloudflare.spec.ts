import { expect, test } from '@playwright/test';
import { editMessage, waitForMessage } from './test-helpers';

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
	await page.evaluate(async () => {
		const socket = (window as any).socket as WebSocket;
		await new Promise<void>(resolve => { socket.onclose = () => resolve(); socket.close(); });
	});
	// Finish the return visit through the actual client. This shares the same
	// canonical ceremony as Go, while the Worker does not issue a resume token.
	await page.goto('/');
	await expect(page.getByTestId('connection-status')).toHaveText('Connected');
	await expect(page.getByLabel('Loading history', { exact: true })).toHaveCount(0);
	const profile = page.getByRole('button', { name: /^Your profile on/ });
	await profile.click();
	const dialog = page.getByRole('dialog', { name: 'Edit profile' });
	await expect(dialog.locator('code')).not.toHaveText(userId);
	await dialog.getByRole('button', { name: 'Sign in with passkey', exact: true }).click();
	await expect(dialog.getByText('Signed in with your passkey.', { exact: true })).toBeVisible();
	await expect(dialog.locator('code')).toHaveText(userId);
	await expect(page.getByLabel('Loading history', { exact: true })).toHaveCount(0);
	await profile.click();
	const savedMessage = page.locator(`article[data-message-id="${posted.result.message_id}"]`);
	await editMessage(savedMessage, 'verified returning owner');
	await waitForMessage(page, 'verified returning owner');
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
