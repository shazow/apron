import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { disablePasskeyAutofill, editMessage, reactionChip, reactTo, sendMessage, startThread, waitForMessage } from './test-helpers';

// This exercises browser-generated credentials and the actual Workers verifier.
// Runtime/storage policy cases live in servers/cloudflare-worker/test.
test('Worker verifies discoverable passkeys, rejects replay and bad signatures, and restores identity', async ({ page, context }) => {
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
		protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
		hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true
	} });
	await disablePasskeyAutofill(page);
	// An actual inert same-origin resource establishes localhost's address space
	// without starting the frontend's extra guest protocol socket.
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
	const guest = await page.evaluate(() => (window as any).request('auth', { scheme: 'guest' }));
	const guestRename = await page.evaluate(() => (window as any).request('me', { name: 'Guest rename' }));
	expect(guestRename.error.code).toBe(-32001);
	expect(guest.result.you.user_id).toBeTruthy();
	const registered = await page.evaluate(() => (window as any).passkey('register'));
	expect(registered.error).toBeUndefined();
	expect(registered.result.you.user_id).not.toBe(guest.result.you.user_id);
	const userId = registered.result.you.user_id;
	const renamed = await page.evaluate(() => (window as any).request('me', { name: 'Saved passkey name' }));
	expect(renamed.result.you).toMatchObject({ user_id: userId, name: 'Saved passkey name' });
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
	// Finish the return visit through the actual client and persist its token.
	await page.goto('/');
	await expect(page.getByTestId('connection-status')).toHaveText('Connected');
	await expect(page.getByLabel('Loading history', { exact: true })).toHaveCount(0);
	const profile = page.getByRole('button', { name: /^Your profile on/ });
	await profile.click();
	const dialog = page.getByRole('dialog', { name: 'Edit profile' });
	await expect(dialog.locator('code')).not.toHaveText(userId);
	// Sign-in lives on the connect screen. The passkey was made over a raw socket,
	// so the client has no record of it and "Continue with passkey" would
	// register; the link signs in with an existing one.
	await dialog.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
	const card = page.getByRole('form', { name: 'Connect to a backend' });
	await card.getByTestId('other-passkey').click();
	await expect(card).toHaveCount(0);
	await profile.click();
	await expect(dialog.locator('code')).toHaveText(userId);
	await expect(dialog.getByTestId('display-name-input')).toHaveValue('Saved passkey name');
	await expect(page.getByLabel('Loading history', { exact: true })).toHaveCount(0);
	await dialog.getByTestId('display-name-input').fill('Returning owner');
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await profile.click();
	await expect(dialog.getByTestId('display-name-input')).toHaveValue('Returning owner');
	await profile.click();
	// No authenticator remains: a reload must resume the stored token without
	// another passkey ceremony, and retain ownership of the earlier message.
	await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
	await page.reload();
	await expect(page.getByTestId('connection-status')).toHaveText('Connected');
	await expect(page.getByLabel('Loading history', { exact: true })).toHaveCount(0);
	await profile.click();
	await expect(dialog.locator('code')).toHaveText(userId);
	await expect(dialog.getByTestId('display-name-input')).toHaveValue('Returning owner');
	await profile.click();
	const savedMessage = page.locator(`article[data-message-id="${posted.result.message_id}"]`);
	await editMessage(savedMessage, 'verified returning owner');
	await waitForMessage(page, 'verified returning owner');
	// Threads on the demo: a thread under General, introduced by the message, with a reaction inside.
	const threadId = await startThread(page, savedMessage);
	await expect(savedMessage).toBeVisible();
	await expect(page.getByRole('heading', { level: 1 })).toContainText('verified returning owner');
	await sendMessage(page, 'worker thread reply');
	const reply = await waitForMessage(page, 'worker thread reply');
	await reactTo(reply, '🎉');
	await expect(reactionChip(reply, '🎉')).toHaveText('🎉1');
	await expect(reactionChip(reply, '🎉')).toHaveAttribute('aria-pressed', 'true');
	await page.getByRole('button', { name: 'Back to room', exact: true }).click();
	await expect(page.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`)).toContainText('verified returning owner');
	await expect(savedMessage).toHaveCount(0);
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
	// The demo denies guest renames; the profile editor says so and keeps the old handle.
	await page.getByRole('button', { name: /^Your profile on/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Edit profile' });
	await dialog.getByTestId('display-name-input').fill('Renamed guest');
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(dialog.getByRole('alert')).toHaveText(
		'The server declined this handle (Only registered users may change their name). Sign in with a passkey and it’s applied once you’re signed in.'
	);
});

test('custom frontend origins share guest quotas and cannot use passkeys', async ({ page }) => {
	const frontend = createServer((req, res) => {
		res.setHeader('Content-Type', 'text/html');
		if (req.url === '/opaque') res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
		res.end('<!doctype html><title>Custom Apron client</title>');
	});
	await new Promise<void>(resolve => frontend.listen(0, resolve));
	const port = (frontend.address() as { port: number }).port;
	try {
		for (const [index, url] of [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://localhost:${port}/opaque`].entries()) {
			await page.goto(url);
			const result = await page.evaluate(async (index) => {
				const socket = new WebSocket('ws://localhost:8788/');
				let sequence = 0;
				const pending = new Map<string, (frame: any) => void>();
				const announcement: any = await new Promise((resolve, reject) => {
					socket.onerror = () => reject(new Error('WebSocket failed'));
					socket.onmessage = event => {
						const frame = JSON.parse(event.data);
						if (frame.method === 'server') resolve(frame.params);
						if (frame.id && pending.has(frame.id)) { pending.get(frame.id)!(frame); pending.delete(frame.id); }
					};
				});
				const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
					const id = `custom-${index}-${++sequence}`;
					const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 10_000);
					pending.set(id, frame => { clearTimeout(timer); resolve(frame); });
					socket.send(JSON.stringify({ id, method, params }));
				});
				try {
					const auth = await request('auth', { scheme: 'guest' });
					const passkey = await request('auth', { scheme: 'webauthn', action: 'register', step: 'begin' });
					let operations: any[] = [];
					if (index === 0) {
						const post = await request('message', { room_id: 'general', body: { text: 'custom frontend' } });
						if (!post.result) throw new Error(JSON.stringify(post));
						const message_id = post.result.message_id;
						operations = [post,
							await request('message', { room_id: 'general', message_id, body: { text: 'custom edit' } }),
							await request('message', { room_id: 'general', message_id, deleted: true })];
						// Earlier browser tests may have used part of this IP's allowance.
						// Spend the remaining allowance on the same tombstone, then ensure
						// another origin cannot reset it. These are local runtime requests.
						for (let i = 0; i < 6; i++) {
							const next = await request('message', { room_id: 'general', message_id, deleted: true });
							if (next.error) break;
						}
					}
					const history = await request('history', { room_id: 'general' });
					const limited = await request('message', { room_id: 'general', body: { text: 'must be rate limited' } });
					return { announcement, auth, passkey, operations, history, limited };
				} finally {
					await new Promise<void>(resolve => { socket.onclose = () => resolve(); socket.close(); });
				}
			}, index);
			expect(result.announcement.auth).toEqual(['guest']);
			expect(result.auth.result.you.user_id).toBeTruthy();
			expect(result.passkey.error.code).toBe(-32001);
			for (const operation of result.operations) expect(operation.error).toBeUndefined();
			expect(result.history.result.entries).toBeInstanceOf(Array);
			expect(result.limited.error.code).toBe(-32002);
			expect(result.limited.error.data.retry_after).toBeGreaterThanOrEqual(1);
			expect(Number.isInteger(result.limited.error.data.retry_after)).toBe(true);
		}
	} finally {
		await new Promise<void>((resolve, reject) => frontend.close(error => error ? reject(error) : resolve()));
	}
});

test('Worker leaves typing off, lists rooms, and colors guest avatars by user_id', async ({ browser }) => {
	const writer = await browser.newContext();
	const reader = await browser.newContext();
	try {
		const pageA = await writer.newPage();
		const pageB = await reader.newPage();
		for (const page of [pageA, pageB]) {
			await page.goto('/');
			await expect(page.getByTestId('connection-status')).toHaveText('Connected');
		}
		// The demo does not advertise `activity`, so typing is never sent or shown.
		// Nothing is posted, so posting quotas are untouched.
		await pageA.getByRole('textbox', { name: 'Message', exact: true }).pressSequentially('hello');
		await pageB.waitForTimeout(500);
		await expect(pageB.locator('.ap-roomhead-typing')).toHaveCount(0);
		// room_list: every room is joined on the demo, so there is nothing to browse.
		await expect(pageB.getByTestId('room-list').locator('[data-room="general"]')).toBeVisible();
		await pageB.waitForTimeout(500);
		await expect(pageB.getByTestId('browse-rooms')).toHaveCount(0);
		// Placeholder avatars take their hue from the user_id, so two guests differ.
		const hue = (page: typeof pageA) => page.locator('.ap-profile-me .ap-avatar').first().evaluate((element) => (element as HTMLElement).style.getPropertyValue('--avatar-hue'));
		const [hueA, hueB] = [await hue(pageA), await hue(pageB)];
		expect(hueA).toMatch(/^\d+$/);
		expect(hueB).toMatch(/^\d+$/);
	} finally {
		await Promise.all([writer.close(), reader.close()]);
	}
});
