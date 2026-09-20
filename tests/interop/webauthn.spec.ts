import { expect, test, type WebSocketRoute } from '@playwright/test';
import { editMessage, openChat, sendMessage, waitForMessage } from './test-helpers';

test.use({ baseURL: 'http://localhost:5173' });

test('passkeys preserve identity and edit ownership through sign-out, login, and reconnect', async ({ page, context }) => {
	let connection!: WebSocketRoute;
	let connections = 0;
	await page.routeWebSocket('**/ws', (route) => {
		route.connectToServer();
		connection = route;
		connections++;
	});
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
		protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
		hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true
	} });
	await openChat(page);
	const message = `passkey-${Date.now()}`;
	await sendMessage(page, message);
	const messageId = await (await waitForMessage(page, message)).getAttribute('data-message-id');
	const savedMessage = page.locator(`article[data-message-id="${messageId}"]`);
	const profile = page.getByRole('button', { name: /^Your profile on/ });
	await profile.click();
	const dialog = page.getByRole('dialog', { name: 'Edit profile' });
	const identity = await dialog.locator('code').textContent();
	await dialog.getByRole('button', { name: 'Add passkey', exact: true }).click();
	await expect(dialog.getByText('Passkey added.', { exact: false })).toBeVisible();
	const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
	expect(credentials).toHaveLength(1);
	expect(credentials[0].isResidentCredential).toBe(true);
	await expect(dialog.locator('code')).toHaveText(identity!);
	await dialog.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page.getByTestId('connection-status')).toHaveText('Connected');
	await expect(dialog.locator('code')).not.toHaveText(identity!);
	await dialog.getByRole('button', { name: 'Sign in with passkey', exact: true }).click();
	await expect(dialog.getByText('Signed in with your passkey.', { exact: true })).toBeVisible();
	await expect(dialog.locator('code')).toHaveText(identity!);
	await expect(page.getByLabel('Loading history', { exact: true })).toHaveCount(0);
	await profile.click();
	await editMessage(savedMessage, `${message}-edited`);
	await waitForMessage(page, `${message}-edited`);
	const beforeReconnect = connections;
	await connection.close({ code: 1012, reason: 'Test transport reconnection' });
	await expect.poll(() => connections).toBeGreaterThan(beforeReconnect);
	await expect(page.getByTestId('connection-status')).toHaveText('Connected', { timeout: 20_000 });
	await profile.click();
	await expect(dialog.locator('code')).toHaveText(identity!);
	await profile.click();
	await expect(page.getByLabel('Loading history', { exact: true })).toHaveCount(0);
	await editMessage(savedMessage, `${message}-resumed`);
	await waitForMessage(page, `${message}-resumed`);
	// A reload deliberately drops the in-memory bearer; the passkey restores the account.
	await page.reload();
	await expect(page.getByTestId('connection-status')).toHaveText('Connected');
	await profile.click();
	await expect(dialog.locator('code')).not.toHaveText(identity!);
	await dialog.getByRole('button', { name: 'Sign in with passkey', exact: true }).click();
	await expect(dialog.locator('code')).toHaveText(identity!);
});

test('a rejected passkey verification leaves the guest usable and allows retry', async ({ page, context }) => {
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
		protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
		hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true
	} });
	await openChat(page);
	await page.getByRole('button', { name: /^Your profile on/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Edit profile' });
	const identity = await dialog.locator('code').textContent();
	await dialog.getByRole('button', { name: 'Add passkey', exact: true }).click();
	await expect(dialog.getByText('Passkey added.', { exact: false })).toBeVisible();
	await dialog.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(dialog.locator('code')).not.toHaveText(identity!);
	await expect(page.getByTestId('connection-status')).toHaveText('Connected');
	const guest = await dialog.locator('code').textContent();
	await cdp.send('WebAuthn.setResponseOverrideBits', { authenticatorId, isBogusSignature: true });
	await dialog.getByRole('button', { name: 'Sign in with passkey', exact: true }).click();
	await expect(dialog.getByRole('alert')).toContainText('Passkey verification failed');
	await expect(dialog.locator('code')).toHaveText(guest!);
	await cdp.send('WebAuthn.setResponseOverrideBits', { authenticatorId, isBogusSignature: false });
	await dialog.getByRole('button', { name: 'Sign in with passkey', exact: true }).click();
	await expect(dialog.locator('code')).toHaveText(identity!);
});

test('changing servers cancels an active passkey prompt', async ({ page, context }) => {
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
		protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
		hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: false
	} });
	await openChat(page);
	await page.getByRole('button', { name: /^Your profile on/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Edit profile' });
	await dialog.getByRole('button', { name: 'Add passkey', exact: true }).click();
	await expect(dialog.getByText('Follow your browser’s passkey prompt…')).toBeVisible();
	await page.getByRole('button', { name: /^Your profile on/ }).click();
	await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
	await page.getByTestId('server-url-input').fill('ws://localhost:8080/ws');
	await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
	await expect(page.getByTestId('connection-status')).toHaveText('Connected');
	await page.getByRole('button', { name: /^Your profile on/ }).click();
	await expect(dialog.getByText('Follow your browser’s passkey prompt…')).toHaveCount(0);
	await expect(dialog.getByRole('button', { name: 'Add passkey', exact: true })).toBeEnabled();
	await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
	await dialog.getByRole('button', { name: 'Add passkey', exact: true }).click();
	await expect(dialog.getByText('Passkey added.', { exact: false })).toBeVisible();
});
