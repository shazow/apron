import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { disablePasskeyAutofill, editMessage, openChat, sendMessage, waitForMessage } from './test-helpers';

test.use({ baseURL: 'http://localhost:5173' });

const profileButton = (page: Page) => page.getByRole('button', { name: /^Your profile on/ });
const profileDialog = (page: Page) => page.getByRole('dialog', { name: 'Edit profile' });
const connectCard = (page: Page) => page.getByRole('form', { name: 'Connect to a backend' });

/** The user_id the profile editor shows, leaving the editor as it found it. */
async function identityOf(page: Page): Promise<string> {
	const wasOpen = await profileDialog(page).count() > 0;
	if (!wasOpen) await profileButton(page).click();
	const identity = await profileDialog(page).locator('code').textContent();
	if (!wasOpen) await profileButton(page).click();
	return identity!;
}

/** Signing in lives on the connect screen; the profile's button opens it with Passkey chosen. */
async function openPasskeySignIn(page: Page): Promise<void> {
	if (!(await profileDialog(page).count())) await profileButton(page).click();
	await profileDialog(page).getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
	await expect(connectCard(page)).toBeVisible();
	await expect(connectCard(page).getByRole('radio', { name: 'Passkey', exact: true })).toHaveAttribute('aria-checked', 'true');
}

async function continueWithPasskey(page: Page): Promise<void> {
	await openPasskeySignIn(page);
	await connectCard(page).getByRole('button', { name: 'Continue with passkey', exact: true }).click();
	await expect(connectCard(page)).toHaveCount(0);
}

async function signOut(page: Page): Promise<void> {
	if (!(await profileDialog(page).count())) await profileButton(page).click();
	await profileDialog(page).getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page.getByTestId('connection-status')).toHaveText('Connected');
	await expect(profileDialog(page).getByRole('button', { name: 'Sign in with a passkey', exact: true })).toBeVisible();
	await profileButton(page).click();
}

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
	await disablePasskeyAutofill(page);
	await openChat(page);
	const message = `passkey-${Date.now()}`;
	await sendMessage(page, message);
	const messageId = await (await waitForMessage(page, message)).getAttribute('data-message-id');
	const savedMessage = page.locator(`article[data-message-id="${messageId}"]`);
	const identity = await identityOf(page);
	// First use on this browser registers a passkey for the current identity.
	await continueWithPasskey(page);
	const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
	expect(credentials).toHaveLength(1);
	expect(credentials[0].isResidentCredential).toBe(true);
	expect(await identityOf(page)).toBe(identity);
	await signOut(page);
	expect(await identityOf(page)).not.toBe(identity);
	// This browser has used a passkey here now, so the same action signs in.
	await continueWithPasskey(page);
	expect(await identityOf(page)).toBe(identity);
	expect((await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials).toHaveLength(1);
	await expect(page.getByLabel('Loading history', { exact: true })).toHaveCount(0);
	await editMessage(savedMessage, `${message}-edited`);
	await waitForMessage(page, `${message}-edited`);
	const beforeReconnect = connections;
	await connection.close({ code: 1012, reason: 'Test transport reconnection' });
	await expect.poll(() => connections).toBeGreaterThan(beforeReconnect);
	await expect(page.getByTestId('connection-status')).toHaveText('Connected', { timeout: 20_000 });
	expect(await identityOf(page)).toBe(identity);
	await expect(page.getByLabel('Loading history', { exact: true })).toHaveCount(0);
	await editMessage(savedMessage, `${message}-resumed`);
	await waitForMessage(page, `${message}-resumed`);
	// A reload resumes the persisted session token: the account survives without a ceremony.
	await page.reload();
	await expect(page.getByTestId('connection-status')).toHaveText('Connected');
	expect(await identityOf(page)).toBe(identity);
	await expect(page.getByLabel('Loading history', { exact: true })).toHaveCount(0);
	// Signing out forgets the stored token, so the next reload starts as a guest.
	await signOut(page);
	await page.reload();
	await expect(page.getByTestId('connection-status')).toHaveText('Connected');
	expect(await identityOf(page)).not.toBe(identity);
	await continueWithPasskey(page);
	expect(await identityOf(page)).toBe(identity);
});

test('a rejected passkey verification leaves the guest usable and allows retry', async ({ page, context }) => {
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
		protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
		hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true
	} });
	await disablePasskeyAutofill(page);
	await openChat(page);
	const identity = await identityOf(page);
	await continueWithPasskey(page);
	await signOut(page);
	const guest = await identityOf(page);
	expect(guest).not.toBe(identity);
	await cdp.send('WebAuthn.setResponseOverrideBits', { authenticatorId, isBogusSignature: true });
	await openPasskeySignIn(page);
	const card = connectCard(page);
	await card.getByRole('button', { name: 'Continue with passkey', exact: true }).click();
	await expect(card.getByRole('alert')).toContainText('Passkey verification failed');
	await card.getByRole('button', { name: 'Cancel', exact: true }).click();
	expect(await identityOf(page)).toBe(guest);
	await cdp.send('WebAuthn.setResponseOverrideBits', { authenticatorId, isBogusSignature: false });
	await continueWithPasskey(page);
	expect(await identityOf(page)).toBe(identity);
});

test('passkey autofill on the connect screen signs a returning user in', async ({ page, context }) => {
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
		protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
		hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true
	} });
	await openChat(page);
	const identity = await identityOf(page);
	await continueWithPasskey(page);
	await signOut(page);
	// With Passkey chosen, the display name field offers the passkey; the virtual
	// authenticator picks it the way a tap on the suggestion would.
	await profileButton(page).click();
	await profileDialog(page).getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
	await expect(connectCard(page)).toHaveCount(0);
	expect(await identityOf(page)).toBe(identity);
});

test('a handle typed in the profile is applied once a passkey signs in', async ({ page, context }) => {
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
		protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
		hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true
	} });
	await disablePasskeyAutofill(page);
	await openChat(page);
	const handle = `handle-${Date.now()}`;
	await profileButton(page).click();
	await profileDialog(page).getByTestId('display-name-input').fill(handle);
	await profileDialog(page).getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
	await expect(connectCard(page).getByTestId('connect-name-input')).toHaveValue(handle);
	await expect(connectCard(page).getByTestId('connect-name-input')).toHaveAttribute('autocomplete', 'username webauthn');
	await connectCard(page).getByRole('button', { name: 'Continue with passkey', exact: true }).click();
	await expect(connectCard(page)).toHaveCount(0);
	await expect(profileButton(page)).toContainText(handle);
});

test('cancelling an active passkey prompt leaves sign-in and server changes usable', async ({ page, context }) => {
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
		protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
		hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: false
	} });
	await disablePasskeyAutofill(page);
	await openChat(page);
	await openPasskeySignIn(page);
	const card = connectCard(page);
	await card.getByRole('button', { name: 'Continue with passkey', exact: true }).click();
	await expect(card.getByRole('button', { name: 'Signing in…', exact: true })).toBeVisible();
	await card.getByRole('button', { name: 'Cancel', exact: true }).click();
	await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
	await page.getByTestId('server-url-input').fill('ws://localhost:8080/ws');
	await card.getByRole('button', { name: 'Connect', exact: true }).click();
	await expect(page.getByTestId('connection-status')).toHaveText('Connected');
	await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
	await continueWithPasskey(page);
	expect((await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials).toHaveLength(1);
});
