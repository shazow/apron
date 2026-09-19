import { expect, test } from '@playwright/test';
import { composer, deleteMessage, messageAction, openChat, sendMessage, waitForMessage } from './test-helpers';

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
	await (await messageAction(root, 'Start thread')).click();
	await expect(page.getByRole('button', { name: 'Back to room', exact: true })).toBeVisible();
	// Under 720px the room list is its own page; open it to read the active thread row.
	await page.getByRole('button', { name: 'Back to rooms', exact: true }).click();
	const threadId = await page.locator('[data-thread][aria-current="page"]').getAttribute('data-thread');
	await page.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`).click();
	const rootInThread = page.locator(`article[data-message-id="${rootId}"]`);
	await expect(rootInThread.locator('.markdown')).toContainText(text.trim());
	const reply = `mobile-reply-${Date.now()}`;
	await sendMessage(page, reply);
	const replyMessage = await waitForMessage(page, reply);
	const replyId = await replyMessage.getAttribute('data-message-id');
	await deleteMessage(page, rootInThread);
	await expect(rootInThread.getByText('Message deleted', { exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: /mobile-thread/ })).toHaveCount(0);
	await expect(composer(page)).toBeEnabled();
	await page.getByRole('button', { name: 'Back to room', exact: true }).click();
	const tombstone = page.locator(`article[data-message-id="${rootId}"]`);
	await expect(tombstone).toHaveCount(0);
	await expect(page.locator(`article[data-message-id="${replyId}"]`)).toHaveCount(0);
	await page.getByRole('button', { name: 'Back to rooms', exact: true }).click();
	await page.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`).click();
	await expect(tombstone.getByText('Message deleted', { exact: true })).toBeVisible();
	await expect(await waitForMessage(page, reply)).toBeVisible();
	const dimensions = await page.evaluate(() => ({
		width: window.innerWidth,
		document: document.documentElement.scrollWidth,
		body: document.body.scrollWidth
	}));
	expect(dimensions.document).toBeLessThanOrEqual(dimensions.width + 1);
	expect(dimensions.body).toBeLessThanOrEqual(dimensions.width + 1);
});
