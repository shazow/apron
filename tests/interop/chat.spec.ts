import { expect, test, type BrowserContext } from '@playwright/test';
import {
	composer,
	deleteMessage,
	editMessage,
	messageAction,
	messageByText,
	moreAction,
	openChat,
	sendMessage,
	waitForDeletedMessage,
	waitForMessage
} from './test-helpers';

test.describe('chat protocol interoperability', () => {
	test('replies to another sender, preserves references on edits, and replays deleted targets', async ({ browser }) => {
		const owner = await browser.newContext();
		const reader = await browser.newContext();
		try {
			const pageA = await owner.newPage();
			const pageB = await reader.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);
			const token = `reply-${Date.now()}`;
			await sendMessage(pageA, `${token}-target`);
			const targetA = await waitForMessage(pageA, `${token}-target`);
			const targetB = await waitForMessage(pageB, `${token}-target`);
			await (await messageAction(targetB, 'Reply to message')).click();
			await expect(pageB.getByTestId('reply-draft')).toContainText(`${token}-target`);
			await pageB.getByRole('button', { name: 'Cancel reply', exact: true }).click();
			await expect(pageB.getByTestId('reply-draft')).toHaveCount(0);
			await (await messageAction(targetB, 'Reply to message')).click();
			await sendMessage(pageB, `${token}-answer`);
			const reply = await waitForMessage(pageB, `${token}-answer`);
			const replyId = await reply.getAttribute('data-message-id');
			const stableReply = pageB.locator(`article[data-message-id="${replyId}"]`);
			await expect(stableReply.getByTestId('reply-reference')).toContainText(`${token}-target`);
			await expect(pageB.getByTestId('reply-draft')).toHaveCount(0);
			await editMessage(stableReply, `${token}-edited`);
			await expect(stableReply).toContainText(`${token}-edited`);
			await expect(stableReply.getByTestId('reply-reference')).toContainText(`${token}-target`);
			await deleteMessage(pageA, targetA);
			await expect(stableReply.getByTestId('reply-reference')).toContainText('Message deleted');
			const history = await reader.newPage();
			await openChat(history);
			const replayed = history.locator(`article[data-message-id="${replyId}"]`);
			await expect(replayed).toContainText(`${token}-edited`);
			await expect(replayed.getByTestId('reply-reference')).toContainText('Message deleted');
			await (await moreAction(stableReply, 'Remove reply reference')).click();
			await expect(stableReply.getByTestId('reply-reference')).toHaveCount(0);
			await expect(replayed.getByTestId('reply-reference')).toHaveCount(0);
		} finally {
			await Promise.all([owner.close(), reader.close()]);
		}
	});

	test('keeps reply drafts in their thread and rejects moves that separate replies', async ({ page }) => {
		await openChat(page);
		const token = `thread-reply-${Date.now()}`;
		await sendMessage(page, `${token}-target`);
		const target = await waitForMessage(page, `${token}-target`);
		const targetId = await target.getAttribute('data-message-id');
		await (await messageAction(target, 'Start thread')).click();
		const selected = page.locator('[data-testid="thread-list"] button[data-thread][aria-current="page"]');
		await expect(selected).toBeVisible();
		const threadId = await selected.getAttribute('data-thread');
		const thread = page.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`);
		const stableTarget = page.locator(`article[data-message-id="${targetId}"]`);
		await (await messageAction(stableTarget, 'Reply to message')).click();
		await composer(page).fill(`${token}-answer`);
		await page.getByRole('button', { name: 'Back to room', exact: true }).click();
		await expect(page.getByTestId('reply-draft')).toHaveCount(0);
		await expect(composer(page)).toHaveValue('');
		await thread.click();
		await expect(page.getByTestId('reply-draft')).toContainText(`${token}-target`);
		await expect(composer(page)).toHaveValue(`${token}-answer`);
		await page.getByRole('button', { name: 'Send message', exact: true }).click();
		const reply = await waitForMessage(page, `${token}-answer`);
		await expect(reply.getByTestId('reply-reference')).toContainText(`${token}-target`);
		await (await moreAction(stableTarget, 'Move message')).click();
		await stableTarget.getByRole('combobox', { name: 'Move message to', exact: true }).selectOption('');
		await expect(page.getByRole('alert')).toContainText('Cannot move a message with replies');
		await expect(stableTarget).toBeVisible();
		await (await moreAction(reply, 'Remove reply reference')).click();
		await expect(reply.getByTestId('reply-reference')).toHaveCount(0);
		await (await messageAction(stableTarget, 'Reply to message')).click();
		await composer(page).fill(`${token}-unsent`);
		await (await moreAction(stableTarget, 'Move message')).click();
		await stableTarget.getByRole('combobox', { name: 'Move message to', exact: true }).selectOption('');
		await expect(stableTarget).toHaveCount(0);
		await expect(page.getByTestId('reply-draft')).toContainText('moved to another thread');
		await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
		await page.getByRole('button', { name: 'Cancel reply', exact: true }).click();
		await expect(composer(page)).toHaveValue(`${token}-unsent`);
		await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
	});

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
			expect(eventId, 'message containers must expose the protocol message ID').toBeTruthy();

			const stableMessageA = pageA.locator(`article[data-message-id="${eventId}"]`);
			await editMessage(stableMessageA, replacement);
			await expect(await waitForMessage(pageA, replacement)).toContainText(replacement);
			await expect(await waitForMessage(pageB, replacement)).toContainText(replacement);
			await expect(pageA.getByText(original, { exact: true })).toHaveCount(0);

			const pageC = await contextC.newPage();
			await openChat(pageC);
			await expect(await waitForMessage(pageC, replacement)).toContainText(replacement);
			await contextC.close();

			await (await messageAction(stableMessageA, 'Edit message')).click();
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
			expect(beforeEventId, 'message containers must expose the protocol message ID').toBeTruthy();

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

	test('starts a thread, preserves destination drafts, moves messages, and replays thread metadata', async ({ browser }) => {
		const contextA = await browser.newContext();
		const contextB = await browser.newContext();
		try {
			const pageA = await contextA.newPage();
			const pageB = await contextB.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);

			const rootText = `thread-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const replyText = `${rootText}-reply`;
			await sendMessage(pageA, rootText);
			const rootA = await waitForMessage(pageA, rootText);
			const rootEventId = await rootA.getAttribute('data-message-id');
			expect(rootEventId).toBeTruthy();
			await waitForMessage(pageB, rootText);

			await (await messageAction(rootA, 'Start thread')).click();
			const threadTab = pageA.locator('[data-testid="thread-list"] button[data-thread][aria-current="page"]');
			await expect(threadTab).toBeVisible();
			const threadId = await threadTab.getAttribute('data-thread');
			const threadButton = pageA.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`);
			expect(threadId).toMatch(/^t_/);
			await expect(pageA.getByRole('button', { name: 'Back to room', exact: true })).toBeVisible();
			const rootB = pageB.locator(`article[data-message-id="${rootEventId}"]`);
			await expect(rootB).toHaveCount(0);
			const roomB = pageB.getByRole('main', { name: 'Conversation' });
			const roomArticlesBefore = await roomB.locator('article[data-message-id]').count();

			await threadButton.click();
			await expect(pageA.getByRole('button', { name: 'Back to room', exact: true })).toBeVisible();
			await expect(await waitForMessage(pageA, rootText)).toContainText(rootText);
			await composer(pageA).fill('draft kept in thread');
			await pageA.getByRole('button', { name: 'Back to room', exact: true }).click();
			await expect(composer(pageA)).toHaveValue('');
			await composer(pageA).fill('draft kept in room');
			await threadButton.click();
			await expect(composer(pageA)).toHaveValue('draft kept in thread');

			await sendMessage(pageA, replyText);
			const replyA = await waitForMessage(pageA, replyText);
			const replyId = await replyA.getAttribute('data-message-id');
			const threadButtonB = pageB.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`);
			await expect(threadButtonB.locator('small')).toHaveText('2');
			await expect(pageB.locator(`article[data-message-id="${replyId}"]`)).toHaveCount(0);
			expect(await roomB.locator('article[data-message-id]').count()).toBe(roomArticlesBefore);

			await threadButtonB.click();
			await expect(await waitForMessage(pageB, replyText)).toContainText(replyText);

			const rootInThread = pageA.locator(`article[data-message-id="${rootEventId}"]`);
			await (await moreAction(rootInThread, 'Move message')).click();
			const moveSelect = rootInThread.getByRole('combobox', { name: 'Move message to', exact: true });
			await moveSelect.selectOption({ label: 'Move to room' });
			await expect(rootInThread).toHaveCount(0);
			await expect(rootB).toHaveCount(0);
			await pageA.getByRole('button', { name: 'Back to room', exact: true }).click();
			await expect(await waitForMessage(pageA, rootText)).toContainText(rootText);

			const threadButtonBeforeReconnect = pageA.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`);
			await expect(threadButtonBeforeReconnect).toBeVisible();
			await contextA.setOffline(true);
			await pageA.reload({ waitUntil: 'commit', timeout: 3_000 }).catch(() => undefined);
			await contextA.setOffline(false);
			await pageA.reload({ waitUntil: 'domcontentloaded' });
			await expect(pageA.getByTestId('connection-status')).toHaveText('Connected', { timeout: 20_000 });
			await expect(threadButton.locator('small')).toHaveText('1');
			await expect(pageA.locator(`article[data-message-id="${replyId}"]`)).toHaveCount(0);
			await expect(pageA.locator(`article[data-message-id="${rootEventId}"]`)).toBeVisible();
			await threadButton.click();
			await expect(pageA.locator(`article[data-message-id="${replyId}"]`)).toBeVisible();
			await expect(pageA.locator(`article[data-message-id="${rootEventId}"]`)).toHaveCount(0);
		} finally {
			await contextA.setOffline(false).catch(() => undefined);
			await Promise.all([contextA.close(), contextB.close()]);
		}
	});
});
