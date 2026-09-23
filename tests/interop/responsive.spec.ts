import { expect, test } from '@playwright/test';
import { composer, deleteMessage, messageAction, moreAction, openChat, reactionChip, reactTo, sendMessage, startThread, waitForMessage } from './test-helpers';

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

test('thread intro previews and the title editor fit a phone viewport', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 740 });
	await openChat(page);
	const token = `mobile-intro-${Date.now()}`;
	const intro = `${token} ${'longword'.repeat(30)}\nSecond line\nThird line\nFourth line\nLast line`;
	await sendMessage(page, intro);
	const message = await waitForMessage(page, token);
	const introId = await message.getAttribute('data-message-id');
	await startThread(page, message);
	await page.getByRole('button', { name: 'Edit thread', exact: true }).click();
	const title = page.getByRole('textbox', { name: 'Thread title', exact: true });
	await expect(title).toHaveValue(new RegExp(`^${token} longword`));
	const titleBounds = await title.boundingBox();
	expect(titleBounds!.x).toBeGreaterThanOrEqual(0);
	expect(titleBounds!.x + titleBounds!.width).toBeLessThanOrEqual(320);
	await title.fill(`${token} renamed`);
	await page.getByRole('button', { name: 'Save thread', exact: true }).click();
	await expect(page.getByRole('heading', { level: 1 })).toContainText(`${token} renamed`);
	await page.getByRole('button', { name: 'Back to room', exact: true }).click();
	const card = page.getByTestId('thread-card').filter({ hasText: token });
	await expect(card).toBeVisible();
	const preview = card.getByTestId('thread-preview');
	await expect(preview).toHaveText(intro);
	const height = await preview.evaluate((node) => ({ height: node.clientHeight, line: Number.parseFloat(getComputedStyle(node).lineHeight) }));
	expect(height.height).toBeLessThanOrEqual(height.line * 3 + 1);
	await card.click();
	await expect(page.locator(`article[data-message-id="${introId}"]`)).toBeInViewport();
	const width = await page.evaluate(() => document.documentElement.scrollWidth);
	expect(width).toBeLessThanOrEqual(321);
});

test('thread replies and deleted intros remain usable on a phone viewport', async ({ page }) => {
	await openChat(page);
	const text = `mobile-thread-${Date.now()}-${'long topic '.repeat(12)}`;
	await sendMessage(page, text);
	const root = await waitForMessage(page, text.trim());
	const rootId = await root.getAttribute('data-message-id');
	const threadId = await startThread(page, root);
	// Under 720px the room list is its own page; the active thread row is listed there.
	await page.getByRole('button', { name: 'Back to rooms', exact: true }).click();
	await expect(page.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`)).toHaveAttribute('aria-current', 'page');
	await page.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`).click();
	const rootInThread = page.locator(`article[data-message-id="${rootId}"]`);
	await expect(rootInThread.locator('.markdown')).toContainText(text.trim());
	const reply = `mobile-reply-${Date.now()}`;
	await (await messageAction(rootInThread, 'Reply to message')).click();
	await expect(page.getByTestId('reply-draft')).toContainText('mobile-thread-');
	await sendMessage(page, reply);
	const replyMessage = await waitForMessage(page, reply);
	await expect(replyMessage.getByTestId('reply-reference')).toContainText('mobile-thread-');
	const replyId = await replyMessage.getAttribute('data-message-id');
	await deleteMessage(page, rootInThread);
	await expect(rootInThread.getByText('Message deleted', { exact: true })).toBeVisible();
	await expect(replyMessage.getByTestId('reply-reference')).toContainText('Message deleted');
	await expect(composer(page)).toBeEnabled();
	await page.getByRole('button', { name: 'Back to room', exact: true }).click();
	// The room shows the thread's card in place of its intro, tombstone or not.
	const tombstone = page.locator(`article[data-message-id="${rootId}"]`);
	await expect(tombstone).toHaveCount(0);
	await expect(page.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`)).toBeVisible();
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

test('reaction chips and the palette fit a narrow screen', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 740 });
	await openChat(page);
	const token = `mobile-react-${Date.now()}`;
	await sendMessage(page, token);
	const messageId = await (await waitForMessage(page, token)).getAttribute('data-message-id');
	const message = page.locator(`article[data-message-id="${messageId}"]`);
	await (await messageAction(message, 'React')).click();
	const palette = message.getByTestId('reaction-palette');
	await expect(palette).toBeVisible();
	const paletteBounds = await palette.boundingBox();
	expect(paletteBounds!.x).toBeGreaterThanOrEqual(0);
	expect(paletteBounds!.x + paletteBounds!.width).toBeLessThanOrEqual(320);
	await palette.getByRole('button', { name: 'React with 👍', exact: true }).click();
	for (const emoji of ['❤️', '😂', '🎉', '😮', '😢', '👀', '✅']) await reactTo(message, emoji);
	await expect(message.getByTestId('reaction-chip')).toHaveCount(8);
	const chips = await message.getByTestId('reactions').boundingBox();
	expect(chips!.x + chips!.width).toBeLessThanOrEqual(320);
	// A chip is a toggle: tapping your own takes it back.
	await reactionChip(message, '👍').tap();
	await expect(reactionChip(message, '👍')).toHaveCount(0);
	const width = await page.evaluate(() => document.documentElement.scrollWidth);
	expect(width).toBeLessThanOrEqual(321);
});

test('room reply controls fit a narrow screen and deleted replies can be detached', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 740 });
	await openChat(page);
	const token = `mobile-reference-${Date.now()}`;
	await sendMessage(page, `${token}-target`);
	const target = await waitForMessage(page, `${token}-target`);
	await (await messageAction(target, 'Reply to message')).click();
	await sendMessage(page, `${token}-answer`);
	const reply = await waitForMessage(page, `${token}-answer`);
	const replyId = await reply.getAttribute('data-message-id');
	const stableReply = page.locator(`article[data-message-id="${replyId}"]`);
	const remove = await moreAction(stableReply, 'Remove reply reference');
	await expect(remove).toBeVisible();
	const bounds = await stableReply.getByRole('toolbar').boundingBox();
	expect(bounds).not.toBeNull();
	expect(bounds!.x).toBeGreaterThanOrEqual(0);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
	page.once('dialog', (dialog) => dialog.accept());
	await stableReply.getByRole('button', { name: 'Delete message', exact: true }).click();
	await expect(stableReply.getByText('Message deleted', { exact: true })).toBeVisible();
	await (await messageAction(stableReply, 'Remove reply reference')).click();
	await expect(stableReply.getByRole('button', { name: 'Remove reply reference', exact: true })).toHaveCount(0);
});
