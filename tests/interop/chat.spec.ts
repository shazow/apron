import { expect, test, type BrowserContext } from '@playwright/test';
import {
	deleteMessage,
	editMessage,
	messageByText,
	openChat,
	sendMessage,
	waitForDeletedMessage,
	waitForMessage
} from './test-helpers';

test.describe('chat protocol interoperability', () => {
	test('broadcasts across independent sessions and recovers history for a new reader', async ({ browser }) => {
		const contextA = await browser.newContext();
		const contextB = await browser.newContext();
		const contextC = await browser.newContext();
		try {
			const pageA = await contextA.newPage();
			const pageB = await contextB.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);

			const text = `broadcast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			await sendMessage(pageA, text);
			await expect(await waitForMessage(pageA, text)).toContainText(text);
			await expect(await waitForMessage(pageB, text)).toContainText(text);

			const pageC = await contextC.newPage();
			await openChat(pageC);
			await expect(await waitForMessage(pageC, text)).toContainText(text);
		} finally {
			await Promise.all([contextA.close(), contextB.close(), contextC.close()]);
		}
	});

	test('propagates edits and deletion, including the resulting history state', async ({ browser }) => {
		const contextA = await browser.newContext();
		const contextB = await browser.newContext();
		const contextC = await browser.newContext();
		let contextD: BrowserContext | undefined;
		try {
			const pageA = await contextA.newPage();
			const pageB = await contextB.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);

			const original = `mutable-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const replacement = `${original}-edited`;
			await sendMessage(pageA, original);
			const messageA = await waitForMessage(pageA, original);
			await waitForMessage(pageB, original);
			const eventId = await messageA.getAttribute('data-message-id');
			expect(eventId, 'message containers must expose the protocol event ID').toBeTruthy();

			const stableMessageA = pageA.locator(`article[data-message-id="${eventId}"]`);
			await editMessage(stableMessageA, replacement);
			await expect(await waitForMessage(pageA, replacement)).toContainText(replacement);
			await expect(await waitForMessage(pageB, replacement)).toContainText(replacement);
			await expect(pageA.getByText(original, { exact: true })).toHaveCount(0);

			const pageC = await contextC.newPage();
			await openChat(pageC);
			await expect(await waitForMessage(pageC, replacement)).toContainText(replacement);
			await contextC.close();

			await stableMessageA.getByRole('button', { name: 'Edit message', exact: true }).click();
			const editor = stableMessageA.getByRole('textbox', { name: 'Edit message', exact: true });
			await expect(editor).toHaveValue(replacement);
			await editor.fill('unsaved draft to discard');
			await deleteMessage(pageA, stableMessageA);
			await waitForDeletedMessage(pageA, eventId as string);
			await expect(editor).toHaveCount(0);
			await expect(stableMessageA.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
			await waitForDeletedMessage(pageB, eventId as string);
			await expect(pageA.getByText(replacement, { exact: true })).toHaveCount(0);
			await expect(pageB.getByText(replacement, { exact: true })).toHaveCount(0);

			contextD = await browser.newContext();
			const pageD = await contextD.newPage();
			await openChat(pageD);
			await waitForDeletedMessage(pageD, eventId as string);
			await expect(pageD.getByText(replacement, { exact: true })).toHaveCount(0);
			await expect(messageByText(pageD, replacement)).toHaveCount(0);
		} finally {
			await Promise.all([contextA.close(), contextB.close(), contextC.close(), contextD?.close()]);
		}
	});

	test('renders untrusted markup without executing or inserting active HTML', async ({ browser }) => {
		const context = await browser.newContext();
		try {
			const page = await context.newPage();
			await openChat(page);

			const token = `markup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const payload = `${token} <img src=x onerror="window.__apronChatXss='${token}'"> <script>window.__apronChatXss='${token}'</script>`;
			await sendMessage(page, payload);
			const message = await waitForMessage(page, token);
			await expect(message).toBeVisible();

			const rendered = await message.evaluate((node) => ({
				scriptCount: node.querySelectorAll('script').length,
				dangerousAttributeCount: node.querySelectorAll('[onerror], [onload], [onclick], [onmouseover]').length,
				javascriptLinkCount: Array.from(node.querySelectorAll('a')).filter((link) =>
					(link.getAttribute('href') ?? '').trim().toLowerCase().startsWith('javascript:')
				).length
			}));
			expect(rendered.scriptCount).toBe(0);
			expect(rendered.dangerousAttributeCount).toBe(0);
			expect(rendered.javascriptLinkCount).toBe(0);
			expect(await page.evaluate(() => (window as Window & { __apronChatXss?: string }).__apronChatXss)).toBeUndefined();
		} finally {
			await context.close();
		}
	});

	test('recovers history once after an offline browser reload', async ({ browser }) => {
		const contextA = await browser.newContext();
		const contextB = await browser.newContext();
		try {
			const pageA = await contextA.newPage();
			const pageB = await contextB.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);

			const beforeReconnect = `reconnect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			await sendMessage(pageA, beforeReconnect);
			const beforeMessageA = await waitForMessage(pageA, beforeReconnect);
			await waitForMessage(pageB, beforeReconnect);
			const beforeEventId = await beforeMessageA.getAttribute('data-message-id');
			expect(beforeEventId, 'message containers must expose the protocol event ID').toBeTruthy();

			await contextA.setOffline(true);
			// Chromium does not reliably close an established WebSocket when a
			// context is taken offline. Reloading while offline tears down the
			// browser document/socket; the expected navigation failure is harmless.
			await pageA.reload({ waitUntil: 'commit', timeout: 3_000 }).catch(() => undefined);
			await contextA.setOffline(false);
			await pageA.reload({ waitUntil: 'domcontentloaded' });
			await expect(pageA.getByTestId('connection-status')).toHaveText('Connected', { timeout: 20_000 });
			await expect(pageA.locator(`article[data-message-id="${beforeEventId}"]`)).toHaveCount(1);

			const afterReconnect = `after-reconnect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			await sendMessage(pageA, afterReconnect);
			await expect(await waitForMessage(pageA, afterReconnect)).toContainText(afterReconnect);
			await expect(await waitForMessage(pageB, afterReconnect)).toContainText(afterReconnect);
		} finally {
			await contextA.setOffline(false).catch(() => undefined);
			await Promise.all([contextA.close(), contextB.close()]);
		}
	});
});
