import { expect, test, type BrowserContext } from '@playwright/test';
import {
	composer,
	deleteMessage,
	editMessage,
	messageAction,
	messageByText,
	moreAction,
	moveMessage,
	openChat,
	sendMessage,
	setDisplayName,
	waitForDeletedMessage,
	waitForMessage
} from './test-helpers';

test.describe('chat protocol interoperability', () => {
	test('previews latest thread messages and edits shared summaries without changing messages', async ({ browser }) => {
		const owner = await browser.newContext();
		const reader = await browser.newContext();
		try {
			const pageA = await owner.newPage();
			const pageB = await reader.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);
			const token = `summary-${Date.now()}`;
			await sendMessage(pageA, `${token}-root`);
			await (await messageAction(await waitForMessage(pageA, `${token}-root`), 'Start thread')).click();
			const selected = pageA.locator('[data-testid="thread-list"] button[aria-current="page"]');
			await expect(selected).toBeVisible();
			await expect(pageA.getByRole('region', { name: 'Thread summary', exact: true })).toHaveCount(0);
			const threadId = await selected.getAttribute('data-thread');
			const cardA = pageA.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`);
			const cardB = pageB.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`);
			await expect(cardB.getByTestId('thread-preview')).toContainText(`${token}-root`);
			await sendMessage(pageA, `${token}-latest`);
			const latest = await waitForMessage(pageA, `${token}-latest`);
			const latestId = await latest.getAttribute('data-message-id');
			await expect(cardB.getByTestId('thread-preview')).toContainText(`${token}-latest`);
			await pageA.getByRole('button', { name: 'Back to room', exact: true }).click();
			await expect(cardA).toContainText('Last reply');
			await expect(cardA.getByTestId('thread-preview')).toContainText(`${token}-latest`);
			await cardA.click();
			await pageA.getByRole('button', { name: 'Edit thread', exact: true }).click();
			await expect(pageA.getByRole('textbox', { name: 'Thread name', exact: true })).toHaveValue(`${token}-root`);
			const summary = `${token} first line\nSecond line\nThird line\nFourth line\nFifth line <b>plain text</b>`;
			// Summaries render as Markdown: raw HTML is dropped, never inserted; the card previews the source.
			const rendered = summary.replace('<b>plain text</b>', 'plain text');
			await pageA.getByRole('textbox', { name: 'Thread summary', exact: true }).fill(summary);
			await pageA.getByRole('button', { name: 'Save thread', exact: true }).click();
			await expect(pageA.getByTestId('thread-summary')).toHaveText(rendered);
			await expect(cardB.getByTestId('thread-preview')).toHaveText(summary);
			const previewBounds = await cardB.getByTestId('thread-preview').evaluate((node) => ({
				height: node.clientHeight, fullHeight: node.scrollHeight, lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight)
			}));
			expect(previewBounds.height).toBeLessThanOrEqual(previewBounds.lineHeight * 3 + 1);
			expect(previewBounds.fullHeight).toBeGreaterThan(previewBounds.height);
			await pageB.reload();
			await expect(cardB.getByTestId('thread-preview')).toHaveText(summary);
			await cardB.click();
			await expect(pageB.getByTestId('thread-summary')).toHaveText(rendered);
			await expect(pageB.getByTestId('thread-summary')).toBeInViewport();
			await expect(pageB.getByTestId('thread-summary').locator('b')).toHaveCount(0);
			await pageB.getByRole('button', { name: 'Edit thread', exact: true }).click();
			await pageB.getByRole('textbox', { name: 'Thread summary', exact: true }).fill('Cancelled draft');
			await pageB.getByRole('textbox', { name: 'Thread name', exact: true }).fill('Cancelled title');
			await pageB.getByRole('region', { name: 'Edit thread', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
			await expect(pageB.getByTestId('thread-summary')).toHaveText(rendered);
			await expect(pageB.getByRole('heading', { level: 1 })).toContainText(`${token}-root`);
			await pageB.getByRole('button', { name: 'Edit thread', exact: true }).click();
			await pageB.getByRole('textbox', { name: 'Thread summary', exact: true }).fill('Updated by another participant');
			await pageB.getByRole('textbox', { name: 'Thread name', exact: true }).fill(`${token}-renamed`);
			await pageB.getByRole('button', { name: 'Save thread', exact: true }).click();
			await expect(pageA.getByTestId('thread-summary')).toHaveText('Updated by another participant');
			await expect(pageA.getByRole('heading', { level: 1 })).toContainText(`${token}-renamed`);
			await pageB.getByRole('button', { name: 'Edit thread', exact: true }).click();
			await pageB.getByRole('textbox', { name: 'Thread summary', exact: true }).fill('');
			await pageB.getByRole('button', { name: 'Save thread', exact: true }).click();
			await expect(pageB.getByRole('button', { name: 'Edit thread', exact: true })).toBeVisible();
			await expect(pageB.getByRole('region', { name: 'Thread summary', exact: true })).toHaveCount(0);
			await expect(pageB.getByRole('region', { name: 'Edit thread', exact: true })).toHaveCount(0);
			await pageB.getByRole('button', { name: 'Back to room', exact: true }).click();
			await expect(cardB).toContainText(`${token}-renamed`);
			await expect(cardB.getByTestId('thread-preview')).toContainText(`${token}-latest`);
			const stableLatest = pageA.locator(`article[data-message-id="${latestId}"]`);
			await editMessage(stableLatest, `${token}-edited`);
			await expect(cardB.getByTestId('thread-preview')).toContainText(`${token}-edited`);
			await deleteMessage(pageA, stableLatest);
			await expect(cardB.getByTestId('thread-preview')).toHaveText('Message deleted');
		} finally {
			await Promise.all([owner.close(), reader.close()]);
		}
	});

	test('shows the jump prompt only when the latest timeline item is outside the viewport', async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 700 });
		await openChat(page);
		const token = `jump-${Date.now()}`;
		await sendMessage(page, token);
		await (await messageAction(await waitForMessage(page, token), 'Start thread')).click();
		const selected = page.locator('[data-testid="thread-list"] button[aria-current="page"]');
		await expect(selected).toBeVisible();
		const threadId = await selected.getAttribute('data-thread');
		await page.getByRole('button', { name: 'Back to room', exact: true }).click();
		await page.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`).click();
		const jump = page.getByRole('button', { name: /^Jump to (latest|new)$/ });
		const list = page.getByTestId('message-list');
		await expect(jump).toHaveCount(0);
		await page.getByRole('button', { name: 'Edit thread', exact: true }).click();
		await page.getByRole('textbox', { name: 'Thread summary', exact: true }).fill(Array.from({ length: 50 }, (_, i) => `Summary line ${i}`).join('\n\n'));
		await page.getByRole('button', { name: 'Save thread', exact: true }).click();
		await expect(jump).toBeVisible();
		await jump.click();
		await expect(jump).toHaveCount(0);
		await list.evaluate((node) => { node.scrollTop = 0; });
		await expect(jump).toBeVisible();
		await page.setViewportSize({ width: 900, height: 1800 });
		await expect(jump).toHaveCount(0);
		await page.setViewportSize({ width: 900, height: 700 });
		await expect(jump).toBeVisible();
		await page.getByRole('button', { name: 'Edit thread', exact: true }).click();
		await page.getByRole('textbox', { name: 'Thread summary', exact: true }).fill('');
		await page.getByRole('button', { name: 'Save thread', exact: true }).click();
		await expect(jump).toHaveCount(0);
	});

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

	test('starts threads from messages with replies and from replies without losing references', async ({ page }) => {
		await openChat(page);
		const token = `start-replied-${Date.now()}`;
		await sendMessage(page, `${token}-target`);
		const target = await waitForMessage(page, `${token}-target`);
		const targetId = await target.getAttribute('data-message-id');
		await (await messageAction(target, 'Reply to message')).click();
		await sendMessage(page, `${token}-answer`);
		const reply = await waitForMessage(page, `${token}-answer`);
		const replyId = await reply.getAttribute('data-message-id');
		await (await messageAction(target, 'Start thread')).click();
		const selected = page.locator('[data-testid="thread-list"] button[data-thread][aria-current="page"]');
		await expect(selected).toBeVisible();
		const targetThreadId = await selected.getAttribute('data-thread');
		await expect(page.locator(`article[data-message-id="${targetId}"]`)).toBeVisible();
		await page.getByRole('button', { name: 'Back to room', exact: true }).click();
		await expect(reply.getByTestId('reply-reference')).toContainText(`${token}-target`);
		await (await messageAction(reply, 'Start thread')).click();
		await expect(selected).toBeVisible();
		await expect(selected).not.toHaveAttribute('data-thread', targetThreadId!);
		const replyThreadId = await selected.getAttribute('data-thread');
		const stableReply = page.locator(`article[data-message-id="${replyId}"]`);
		await expect(stableReply.getByTestId('reply-reference')).toContainText(`${token}-target`);
		await stableReply.getByTestId('reply-reference').click();
		await expect(selected).toHaveAttribute('data-thread', targetThreadId!);
		await expect(page.locator(`article[data-message-id="${targetId}"]`)).toBeFocused();
		await page.reload();
		await page.locator(`[data-testid="thread-list"] button[data-thread="${replyThreadId}"]`).click();
		await expect(stableReply.getByTestId('reply-reference')).toContainText(`${token}-target`);
	});

	test('keeps reply drafts and references when their target moves across threads', async ({ page }) => {
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
		await (await messageAction(stableTarget, 'Reply to message')).click();
		await composer(page).fill(`${token}-unsent`);
		await moveMessage(page, stableTarget, 'room');
		await expect(stableTarget).toHaveCount(0);
		await expect(reply.getByTestId('reply-reference')).toContainText(`${token}-target`);
		await expect(page.getByTestId('reply-draft')).toContainText(`${token}-target`);
		await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
		await reply.getByTestId('reply-reference').click();
		await expect(stableTarget).toBeVisible();
		await expect(composer(page)).toHaveValue('');
		await thread.click();
		await expect(composer(page)).toHaveValue(`${token}-unsent`);
		await page.getByRole('button', { name: 'Send message', exact: true }).click();
		const crossThreadReply = await waitForMessage(page, `${token}-unsent`);
		await expect(crossThreadReply.getByTestId('reply-reference')).toContainText(`${token}-target`);
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
			await moveMessage(pageA, rootInThread, 'room');
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

	test('names someone from the picker, chips the mention, and pings only the person named', async ({ browser }) => {
		const writer = await browser.newContext();
		const named = await browser.newContext();
		try {
			const pageA = await writer.newPage();
			const pageB = await named.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);
			const handle = `dana-${Date.now().toString(36)}`;
			await setDisplayName(pageB, handle);
			await sendMessage(pageB, `${handle} is here`);
			await waitForMessage(pageA, `${handle} is here`);

			// Typing `@` opens the picker on the senders this room has seen.
			await composer(pageA).fill('Handing this to @dana');
			const picker = pageA.getByTestId('mention-picker');
			await expect(picker.getByRole('option', { name: new RegExp(handle) })).toBeVisible();
			await expect(picker.locator('.ap-mpick-hit').first()).toHaveText('dana');
			await composer(pageA).press('Tab');
			await expect(composer(pageA)).toHaveValue(`Handing this to @${handle} `);
			await expect(picker).toHaveCount(0);

			await composer(pageA).fill(`Handing this to @${handle} and @nobody-here`);
			await pageA.getByRole('button', { name: 'Send message', exact: true }).click();
			const sent = await waitForMessage(pageA, 'Handing this to');
			// The writer isn't the one named: a chip, no tint, and unknown handles stay plain text.
			await expect(sent.locator('.ap-mention')).toHaveText(`@${handle}`);
			await expect(sent.locator('.ap-mention-me')).toHaveCount(0);
			await expect(sent).not.toHaveClass(/ap-msg-mention/);
			const received = await waitForMessage(pageB, 'Handing this to');
			await expect(received.locator('.ap-mention-me')).toHaveText(`@${handle}`);
			await expect(received).toHaveClass(/ap-msg-mention/);

			// A handle inside code is code, and a message you send yourself never pings you.
			await sendMessage(pageB, `\`@${handle}\` stays code`);
			const quoted = await waitForMessage(pageB, 'stays code');
			await expect(quoted.locator('.ap-mention')).toHaveCount(0);
			await expect(quoted).not.toHaveClass(/ap-msg-mention/);
		} finally {
			await Promise.all([writer.close(), named.close()]);
		}
	});

	test('turns the jump bar rust when a mention lands above the fold', async ({ browser }) => {
		const writer = await browser.newContext();
		const named = await browser.newContext();
		try {
			const pageA = await writer.newPage();
			const pageB = await named.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);
			await pageB.setViewportSize({ width: 900, height: 700 });
			const handle = `sam-${Date.now().toString(36)}`;
			await setDisplayName(pageB, handle);

			await sendMessage(pageA, `${handle}-root`);
			await (await messageAction(await waitForMessage(pageA, `${handle}-root`), 'Start thread')).click();
			const threadTab = pageA.locator('[data-testid="thread-list"] button[data-thread][aria-current="page"]');
			await expect(threadTab).toBeVisible();
			const threadId = await threadTab.getAttribute('data-thread');
			await pageA.getByRole('button', { name: 'Edit thread', exact: true }).click();
			await pageA.getByRole('textbox', { name: 'Thread summary', exact: true }).fill(Array.from({ length: 50 }, (_, line) => `Summary line ${line}`).join('\n\n'));
			await pageA.getByRole('button', { name: 'Save thread', exact: true }).click();

			await pageB.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`).click();
			await expect(pageB.getByTestId('thread-summary')).toBeVisible();
			await pageB.getByTestId('message-list').evaluate((node) => { node.scrollTop = 0; });
			await expect(pageB.getByTestId('jump-button')).toHaveText('Jump to latest');

			// The mention arrives out of sight: the bar turns rust and offers the mention itself.
			await sendMessage(pageA, `@${handle} can you check the migration logs?`);
			const jump = pageB.getByTestId('jump-button');
			await expect(jump).toHaveText('Jump to mention');
			await expect(pageB.locator('.ap-jumpbar-at')).toBeVisible();
			await jump.click();
			const pinged = await waitForMessage(pageB, 'migration logs');
			await expect(pinged).toBeInViewport();
			await expect(pinged).toHaveClass(/ap-msg-mention/);
			await expect(jump).toHaveCount(0);
		} finally {
			await Promise.all([writer.close(), named.close()]);
		}
	});

	test('picks a range of messages and moves them into one new thread', async ({ browser }) => {
		const mover = await browser.newContext();
		const reader = await browser.newContext();
		try {
			const pageA = await mover.newPage();
			const pageB = await reader.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);
			const token = `select-${Date.now().toString(36)}`;
			for (const suffix of ['one', 'two', 'three']) await sendMessage(pageA, `${token}-${suffix}`);
			const first = await waitForMessage(pageA, `${token}-one`);
			const last = await waitForMessage(pageA, `${token}-three`);
			const firstId = await first.getAttribute('data-message-id');
			await waitForMessage(pageB, `${token}-three`);

			// Shift-click enters select mode with that message picked; a second one fills the range.
			await first.click({ modifiers: ['Shift'] });
			const bar = pageA.getByTestId('selection-bar');
			await expect(bar).toContainText('1 message selected');
			await expect(pageA.getByTestId('message-input')).toHaveCount(0);
			await last.click({ modifiers: ['Shift'] });
			await expect(bar).toContainText('3 messages selected');
			await expect(pageA.locator('article.ap-msg-selected')).toHaveCount(3);
			// Hover actions stand down while messages are being picked.
			await first.hover();
			await expect(first.getByRole('button', { name: 'Edit message', exact: true })).toHaveCount(0);

			await pageA.keyboard.press('Escape');
			await expect(bar).toHaveCount(0);
			await expect(composer(pageA)).toBeVisible();

			await first.click({ modifiers: ['Shift'] });
			await last.click({ modifiers: ['Shift'] });
			await pageA.getByTestId('new-thread').click();
			const threadTab = pageA.locator('[data-testid="thread-list"] button[data-thread][aria-current="page"]');
			await expect(threadTab).toBeVisible();
			const threadId = await threadTab.getAttribute('data-thread');
			expect(threadId).toMatch(/^t_/);
			await expect(pageA.getByTestId('selection-bar')).toHaveCount(0);
			for (const suffix of ['one', 'two', 'three']) await expect(await waitForMessage(pageA, `${token}-${suffix}`)).toBeVisible();

			// The room keeps the thread's root and loses the replies; the other reader sees the same.
			await pageA.getByRole('button', { name: 'Back to room', exact: true }).click();
			await expect(pageA.locator(`article[data-message-id="${firstId}"]`)).toHaveCount(0);
			await expect(pageA.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`)).toBeVisible();
			const threadButtonB = pageB.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`);
			await expect(threadButtonB.locator('small')).toHaveText('3');
			await threadButtonB.click();
			for (const suffix of ['one', 'three']) await expect(await waitForMessage(pageB, `${token}-${suffix}`)).toBeVisible();
		} finally {
			await Promise.all([mover.close(), reader.close()]);
		}
	});
});
