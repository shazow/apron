import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { composer, disablePasskeyAutofill, editMessage, openThread, reactionChip, reactTo, sendMessage, startThread, userIdOf, waitForMessage } from './test-helpers';

/** A virtual authenticator that answers this page's passkey prompts on its own. */
async function addAuthenticator(page: Page): Promise<void> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
		protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
		hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true
	} });
}

/** Signs a guest in from the read-only bar: the connect screen creates a passkey on this device. */
async function signInFromReadOnlyBar(page: Page): Promise<void> {
	await page.getByTestId('read-only-signin').click();
	const card = page.getByRole('form', { name: 'Connect to a backend' });
	await card.getByRole('button', { name: 'Continue with passkey', exact: true }).click();
	await expect(card).toHaveCount(0);
	await expect(page.getByTestId('read-only-bar')).toHaveCount(0);
	await expect(composer(page)).toBeEnabled();
}

// This exercises browser-generated credentials and the actual Workers verifier.
// Runtime/storage policy cases live in servers/cloudflare-worker/test.
test('Worker verifies discoverable passkeys, rejects replay and bad signatures, restores identity, and invites a bot', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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
	// The new identity starts in the guest's rooms, and each start is a logged
	// membership that reaches this connection before the auth result (§4.3.2).
	const joins = await page.evaluate(() => (window as any).frames.filter((frame: any) => frame.method === 'membership'));
	expect(joins).toEqual([{ method: 'membership', params: {
		log_id: expect.stringMatching(/^[1-9][0-9]*$/), room_id: 'general',
		members: [{ user: { user_id: userId, name: registered.result.you.name }, joined: true }],
	} }]);
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
	const threadCard = page.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`);
	await expect(threadCard).toContainText('verified returning owner');
	await expect(savedMessage).toHaveCount(0);
	// A thread's members are those who joined it: leaving drops its row but
	// keeps its card in General. The card opens the thread read-only, and
	// joining makes it live again.
	page.on('dialog', (dialog) => dialog.accept());
	const row = page.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`);
	await openThread(page, threadId);
	await page.getByTestId('leave-room').click();
	await expect(row).toHaveCount(0);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('General');
	await expect(threadCard).toBeVisible();
	await openThread(page, threadId);
	await expect(page.getByRole('heading', { level: 1 })).toContainText('verified returning owner');
	await expect(page.getByTestId('join-room')).toBeVisible();
	await expect(reply).toBeVisible();
	await openThread(page, threadId, { join: true });
	await expect(row).toHaveCount(1);

	// The owner invites a bot from the composer. The Worker allows ten
	// connection attempts a minute from this one IP, so the bot rides this
	// signed-in page rather than a test of its own.
	await page.getByRole('button', { name: 'Back to room', exact: true }).click();
	await composer(page).fill('/invite-bot');
	await page.getByRole('button', { name: 'Run command', exact: true }).click();
	// The token comes in a private notice, in a code block with a Copy button.
	const notice = page.getByTestId('notice').filter({ hasText: 'Your bot signs in as' });
	await expect(notice).toBeVisible();
	await expect(notice.locator('.ap-notice-title')).toHaveText('System message to you');
	const botName = (await notice.locator('strong').first().textContent())!;
	expect(botName).toMatch(/^Bot of /);
	const block = notice.locator('pre').first();
	const token = (await block.locator('code').textContent())!.trim();
	expect(token).toMatch(/^apron_bot_[A-Za-z0-9_-]+$/);
	await block.getByRole('button', { name: 'Copy', exact: true }).click();
	await expect(block.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
	// A new bot joins General, which the room shows like any join.
	await expect(page.getByTestId('membership-line').filter({ hasText: botName })).toBeVisible();

	// The bot is a program, not a browser: it connects from Node, without an Origin.
	const bot = new WebSocket('ws://localhost:8788/ws');
	const frames: any[] = [];
	const waiters: Array<{ match: (frame: any) => boolean; resolve: (frame: any) => void }> = [];
	bot.addEventListener('message', (event) => {
		const frame = JSON.parse(String(event.data));
		const index = waiters.findIndex((waiter) => waiter.match(frame));
		if (index >= 0) waiters.splice(index, 1)[0].resolve(frame); else frames.push(frame);
	});
	const next = (match: (frame: any) => boolean): Promise<any> => {
		const index = frames.findIndex(match);
		if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
		return new Promise((resolve) => waiters.push({ match, resolve }));
	};
	try {
		const server = await next((frame) => frame.method === 'server');
		expect(server.params.auth).toEqual(['token', 'guest']);
		bot.send(JSON.stringify({ method: 'auth', id: 'auth', params: { scheme: 'token', token } }));
		const auth = await next((frame) => frame.id === 'auth');
		expect(auth.result.you.user_id).toMatch(/^bot_u_/);
		expect(auth.result.you.name).toBe(botName);
		bot.send(JSON.stringify({ method: 'message', id: 'post', params: { room_id: 'general', body: { text: 'beep from the bot' } } }));
		expect((await next((frame) => frame.id === 'post')).result.message_id).toBeTruthy();
		await expect(await waitForMessage(page, 'beep from the bot')).toContainText(botName);
	} finally {
		bot.close();
	}
});

test('custom frontend origins read as guests, cannot post, and cannot use passkeys', async ({ page }) => {
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
					const history = await request('history', { room_id: 'general' });
					const post = await request('message', { room_id: 'general', body: { text: 'custom frontend' } });
					return { announcement, auth, passkey, history, post };
				} finally {
					await new Promise<void>(resolve => { socket.onclose = () => resolve(); socket.close(); });
				}
			}, index);
			// `token` is for bot tokens; passkeys and their sessions stay on the demo's own origin.
			expect(result.announcement.auth).toEqual(['token', 'guest']);
			expect(result.announcement.ext.demo.guest_posting).toBe(false);
			expect(result.auth.result.you.user_id).toBeTruthy();
			expect(result.passkey.error.code).toBe(-32001);
			expect(result.history.result.messages).toBeInstanceOf(Array);
			expect(result.post.error.code).toBe(-32001);
			expect(result.post.error.message).toMatch(/sign in/);
		}
	} finally {
		await new Promise<void>((resolve, reject) => frontend.close(error => error ? reject(error) : resolve()));
	}
});

test('Worker keeps guests read-only, leaves typing off, lists rooms, lets guests open threads without joining, colors avatars by user_id, and offers room members to mention', async ({ browser }) => {
	const writer = await browser.newContext();
	const reader = await browser.newContext();
	try {
		const pageA = await writer.newPage();
		const pageB = await reader.newPage();
		// The picker lists members again when its list is over 15 seconds old; the test skips ahead.
		await pageA.clock.install();
		await addAuthenticator(pageA);
		await disablePasskeyAutofill(pageA);
		for (const page of [pageA, pageB]) {
			await page.goto('/');
			await expect(page.getByTestId('connection-status')).toHaveText('Connected');
		}
		// Guests only read: the server says so in a private notice, and the
		// composer gives way to a sign-in bar. The reader stays a guest.
		await expect(pageB.getByText('This demo keeps roughly the last day of history; older messages may expire.')).toBeVisible();
		await expect(pageB.getByTestId('notice').filter({ hasText: 'You’re reading as a guest.' })).toBeVisible();
		await expect(pageB.getByTestId('read-only-bar')).toContainText('Sign in to post, react, join rooms, and start threads.');
		await expect(composer(pageB)).toHaveCount(0);
		// The demo denies guest renames; the profile editor says so and keeps the old handle.
		await pageB.getByRole('button', { name: /^Your profile on/ }).click();
		const dialog = pageB.getByRole('dialog', { name: 'Edit profile' });
		await dialog.getByTestId('display-name-input').fill('Renamed guest');
		await dialog.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(dialog.getByRole('alert')).toHaveText(
			'The server declined this handle (Only registered users may change their name). Sign in with a passkey and it’s applied once you’re signed in.'
		);
		await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		// The writer signs in from the bar.
		await signInFromReadOnlyBar(pageA);
		// The demo does not advertise `activity`, so typing is never sent or shown.
		// Nothing is posted, so posting quotas are untouched.
		await pageA.getByRole('textbox', { name: 'Message', exact: true }).pressSequentially('hello');
		await pageB.waitForTimeout(500);
		await expect(pageB.locator('.ap-roomhead-typing')).toHaveCount(0);
		// Mentions offer General's members: the viewer and the reader, and the
		// registered members an earlier test may have left behind, but none of
		// the earlier guests whose messages are still in the room: a guest's
		// membership ends with its connection. Guests keep the server's name,
		// which ends in their user_id's last six characters.
		const readerName = new RegExp((await userIdOf(pageB)).slice(-6));
		const field = composer(pageA);
		const picker = pageA.getByTestId('mention-picker');
		await pageA.clock.fastForward(16_000);
		await field.fill('@');
		await expect(picker.getByRole('option', { name: readerName })).toBeVisible();
		const members = await picker.getByRole('option').count();
		expect(members).toBeGreaterThanOrEqual(2);
		await field.fill('');
		await expect(picker).toHaveCount(0);
		// room_list: a new guest has joined General, the demo's only top-level
		// room, so there is nothing to browse.
		await expect(pageB.getByTestId('room-list').locator('[data-room="general"]')).toBeVisible();
		await pageB.waitForTimeout(500);
		await expect(pageB.getByTestId('browse-rooms')).toHaveCount(0);
		// Joining and leaving are writes too, so the guest gets neither button.
		await expect(pageB.getByTestId('leave-room')).toHaveCount(0);
		// The writer starts a thread; the guest opens it from More threads…
		// without joining, and reads it through its history.
		await sendMessage(pageA, 'a thread guests can read');
		const threadId = await startThread(pageA, await waitForMessage(pageA, 'a thread guests can read'));
		await pageA.getByRole('button', { name: 'Back to room', exact: true }).click();
		await pageB.getByTestId('more-threads').click();
		const listed = pageB.locator(`[data-join="${threadId}"]`);
		await expect(listed).toContainText('Open');
		await listed.click();
		await expect(pageB.getByRole('heading', { level: 1 })).toContainText('a thread guests can read');
		await expect(pageB.getByTestId('join-room')).toHaveCount(0);
		await expect(pageB.getByTestId('read-only-bar')).toBeVisible();
		await pageB.getByRole('button', { name: 'Back to room', exact: true }).click();
		// The signed-in writer can leave General, browse to it, and join it again.
		pageA.on('dialog', (dialog) => dialog.accept());
		await pageA.getByTestId('leave-room').click();
		await expect(pageA.getByTestId('room-list').locator('button[data-room="general"]')).toHaveCount(0);
		await pageA.getByTestId('browse-rooms').click();
		const general = pageA.getByTestId('room-directory').locator('[data-join="general"]');
		await expect(general).toContainText('Join');
		await general.click();
		await expect(pageA.getByRole('main', { name: 'Conversation' }).getByRole('heading', { name: 'General', exact: true })).toBeVisible();
		// Placeholder avatars take their hue from the user_id, so two guests differ.
		const hue = (page: typeof pageA) => page.locator('.ap-profile-me .ap-avatar').first().evaluate((element) => (element as HTMLElement).style.getPropertyValue('--avatar-hue'));
		const [hueA, hueB] = [await hue(pageA), await hue(pageB)];
		expect(hueA).toMatch(/^\d+$/);
		expect(hueB).toMatch(/^\d+$/);

		// The reader leaves; a stale members list is listed again when the picker opens.
		await reader.close();
		// Its close frame reaches the server on its own connection; let it land first.
		await pageA.waitForTimeout(1_000);
		await pageA.clock.fastForward(16_000);
		await field.fill('@');
		await expect(picker.getByRole('option', { name: readerName })).toHaveCount(0);
		await expect(picker.getByRole('option')).toHaveCount(members - 1);
	} finally {
		await Promise.all([writer.close(), reader.close()]);
	}
});
