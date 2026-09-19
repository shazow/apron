import { expect, test } from '@playwright/test';
import { composer, deleteMessage, openChat, sendMessage, waitForMessage } from './test-helpers';

test('chat remains usable without horizontal overflow on a phone viewport', async ({ page }) => {
	await openChat(page);
	await expect(composer(page)).toBeVisible();

	const dimensions = await page.evaluate(() => ({
		innerWidth: window.innerWidth,
		documentWidth: document.documentElement.scrollWidth,
		bodyWidth: document.body.scrollWidth
	}));
	expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.innerWidth + 1);
	expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.innerWidth + 1);
});

test('thread replies and deleted roots remain usable on a phone viewport', async ({ page }) => {
	await openChat(page);
	const text = `mobile-thread-${Date.now()}-${'long topic '.repeat(12)}`;
	await sendMessage(page, text);
	const root = await waitForMessage(page, text);
	const rootId = await root.getAttribute('data-message-id');
	await root.getByTestId('start-thread').click();
	await expect(page.getByRole('button', { name: 'Back to room', exact: true })).toBeVisible();
	const rootInThread = page.locator(`article[data-message-id="${rootId}"]`);
	await expect(rootInThread.locator('.markdown')).toContainText(text.trim());
	const reply = `mobile-reply-${Date.now()}`;
	await sendMessage(page, reply);
	await waitForMessage(page, reply);
	await deleteMessage(page, rootInThread);
	await expect(rootInThread.getByText('Message deleted', { exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: /mobile-thread/ })).toHaveCount(0);
	await expect(composer(page)).toBeEnabled();
	await page.getByRole('button', { name: 'Back to room', exact: true }).click();
	const tombstone = page.locator(`article[data-message-id="${rootId}"]`);
	await expect(tombstone.getByText('Message deleted', { exact: true })).toBeVisible();
	await tombstone.locator('.thread-link').click();
	await expect(await waitForMessage(page, reply)).toBeVisible();
	const dimensions = await page.evaluate(() => ({
		width: window.innerWidth,
		document: document.documentElement.scrollWidth,
		body: document.body.scrollWidth
	}));
	expect(dimensions.document).toBeLessThanOrEqual(dimensions.width + 1);
	expect(dimensions.body).toBeLessThanOrEqual(dimensions.width + 1);
});
