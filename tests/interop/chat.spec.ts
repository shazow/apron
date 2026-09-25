import { expect, test, type BrowserContext } from '@playwright/test';
import {
	composer,
	deleteMessage,
	editMessage,
	emojiPicker,
	messageAction,
	messageByText,
	moreAction,
	moveMessage,
	openChat,
	openThread,
	pickFromEmojiPicker,
	reactionChip,
	reactTo,
	recordOffsiteRequests,
	sendMessage,
	setDisplayName,
	startThread,
	userIdOf,
	waitForDeletedMessage,
	waitForMessage
} from './test-helpers';

test.describe('chat protocol interoperability', () => {
	test('previews thread intros, falls back to the latest message, and edits shared thread titles', async ({ browser }) => {
		const owner = await browser.newContext();
		const reader = await browser.newContext();
		try {
			const pageA = await owner.newPage();
			const pageB = await reader.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);
			const token = `intro-${Date.now()}`;
			const introText = `${token} first line\nSecond line\nThird line\nFourth line\nFifth line`;
			await sendMessage(pageA, introText);
			const introA = await waitForMessage(pageA, `${token} first line`);
			const introId = await introA.getAttribute('data-message-id');
			await waitForMessage(pageB, `${token} first line`);
			const threadId = await startThread(pageA, introA);
			// The intro stays in the room and leads the thread, pinned under its header.
			const pinnedA = pageA.locator(`article[data-message-id="${introId}"]`);
			await expect(pinnedA).toBeVisible();
			// Typed line breaks survive Markdown rendering, in the message and in the card.
			await expect(pinnedA.locator('.markdown br')).toHaveCount(4);
			expect(await pinnedA.locator('.markdown').evaluate((node) => (node as HTMLElement).innerText)).toBe(introText);
			await expect(pageA.getByRole('heading', { level: 1 })).toContainText(`${token} first line`);
			const cardA = pageA.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`);
			const cardB = pageB.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`);
			// In the room feed the intro is shown as its thread's card, previewing up to three lines.
			await expect(cardB.getByTestId('thread-preview')).toHaveText(introText);
			await expect(pageB.locator(`article[data-message-id="${introId}"]`)).toHaveCount(0);
			expect(await cardB.getByTestId('thread-preview').evaluate((node) => (node as HTMLElement).innerText)).toBe(introText);
			await expect(pageB.getByTestId('reconnect-divider')).toHaveCount(0);
			const previewBounds = await cardB.getByTestId('thread-preview').evaluate((node) => ({
				height: node.clientHeight, fullHeight: node.scrollHeight, lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight)
			}));
			expect(previewBounds.height).toBeLessThanOrEqual(previewBounds.lineHeight * 3 + 1);
			expect(previewBounds.fullHeight).toBeGreaterThan(previewBounds.height);
			await sendMessage(pageA, `${token}-latest`);
			const latestId = await (await waitForMessage(pageA, `${token}-latest`)).getAttribute('data-message-id');
			await pageA.getByRole('button', { name: 'Back to room', exact: true }).click();
			await expect(cardA).toContainText('Last reply');
			await expect(cardA.getByTestId('thread-preview')).toHaveText(introText);

			await pageB.reload();
			await expect(cardB.getByTestId('thread-preview')).toHaveText(introText);
			await cardB.click();
			await expect(pageB.locator(`article[data-message-id="${introId}"]`)).toBeInViewport();
			// Opening a thread for the first time is not a reconnect.
			await expect(pageB.getByTestId('reconnect-divider')).toHaveCount(0);
			await expect(await waitForMessage(pageB, `${token}-latest`)).toBeVisible();
			await pageB.getByRole('button', { name: 'Edit thread', exact: true }).click();
			const titleB = pageB.getByRole('textbox', { name: 'Thread title', exact: true });
			await expect(titleB).toHaveValue(`${token} first line`);
			await titleB.fill('Cancelled title');
			await pageB.getByRole('region', { name: 'Edit thread', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
			await expect(pageB.getByRole('heading', { level: 1 })).toContainText(`${token} first line`);
			await pageB.getByRole('button', { name: 'Edit thread', exact: true }).click();
			await titleB.fill(`${token}-renamed`);
			await pageB.getByRole('button', { name: 'Save thread', exact: true }).click();
			await expect(pageB.getByRole('region', { name: 'Edit thread', exact: true })).toHaveCount(0);
			await expect(pageB.getByRole('heading', { level: 1 })).toContainText(`${token}-renamed`);
			await expect(cardA).toContainText(`${token}-renamed`);
			// The rename shows in the thread as a system line, live and when its history loads again.
			const renamed = `Thread renamed to “${token}-renamed”`;
			await expect(pageB.getByTestId('thread-renamed')).toContainText(renamed);
			await pageB.reload();
			await cardB.click();
			await expect(pageB.getByTestId('thread-renamed')).toContainText(renamed);
			await pageB.getByRole('button', { name: 'Back to room', exact: true }).click();
			await expect(cardB).toContainText(`${token}-renamed`);

			// Editing the intro message edits the preview; without it, the card previews the latest message.
			await cardA.click();
			await expect(pageA.getByTestId('thread-renamed')).toContainText(renamed);
			await editMessage(pinnedA, `${token} edited intro`);
			await expect(cardB.getByTestId('thread-preview')).toHaveText(`${token} edited intro`);
			await deleteMessage(pageA, pinnedA);
			await expect(pinnedA.getByText('Message deleted', { exact: true })).toBeVisible();
			await expect(cardB.getByTestId('thread-preview')).toHaveText(`${token}-latest`);
			const stableLatest = pageA.locator(`article[data-message-id="${latestId}"]`);
			await editMessage(stableLatest, `${token}-edited`);
			await expect(cardB.getByTestId('thread-preview')).toContainText(`${token}-edited`);
			await deleteMessage(pageA, stableLatest);
			await expect(cardB.getByTestId('thread-preview')).toHaveText('Message deleted');
		} finally {
			await Promise.all([owner.close(), reader.close()]);
		}
	});

	test('keeps line breaks in plain-format bodies, their thread card, and a reply quote', async ({ page }) => {
		await openChat(page);
		const token = `plain-${Date.now()}`;
		const text = `${token} first line\nsecond   line\n\nfourth *not emphasis*`;
		// The composer sends Markdown; post a body without `format` (plain by default) over a raw socket.
		await page.evaluate(async (body) => {
			const socket = new WebSocket(new URL('/ws', location.href).href.replace(/^http/, 'ws'));
			await new Promise<void>((resolve, reject) => {
				socket.onerror = () => reject(new Error('socket failed'));
				socket.onmessage = (event) => {
					const frame = JSON.parse(event.data);
					if (frame.method === 'server') socket.send(JSON.stringify({ id: 'a1', method: 'auth', params: { scheme: 'guest' } }));
					if (frame.id === 'a1') socket.send(JSON.stringify({ id: 'm1', method: 'message', params: { room_id: 'general', body: { text: body } } }));
					if (frame.id === 'm1') { socket.close(); resolve(); }
				};
			});
		}, text);
		const message = await waitForMessage(page, `${token} first line`);
		const plain = message.locator('.ap-msg-text');
		await expect(plain).toHaveClass(/plain/);
		expect(await plain.evaluate((node) => (node as HTMLElement).innerText)).toBe(text);
		await expect(plain.locator('em')).toHaveCount(0);
		await (await messageAction(message, 'Reply to message')).click();
		await sendMessage(page, `${token}-answer`);
		const answer = await waitForMessage(page, `${token}-answer`);
		// A quote is one line: the first non-empty one.
		await expect(answer.getByTestId('reply-reference')).toContainText(`${token} first line`);
		await expect(answer.getByTestId('reply-reference')).not.toContainText('second');
		const messageId = await message.getAttribute('data-message-id');
		const threadId = await startThread(page, page.locator(`article[data-message-id="${messageId}"]`));
		await page.getByRole('button', { name: 'Back to room', exact: true }).click();
		const preview = page.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`).getByTestId('thread-preview');
		expect(await preview.evaluate((node) => (node as HTMLElement).innerText)).toBe(text);
	});

	test('opens a long thread on its newest replies and loads older ones on scrolling back', async ({ browser }) => {
		const owner = await browser.newContext();
		const reader = await browser.newContext();
		try {
			const pageA = await owner.newPage();
			await openChat(pageA);
			const token = `older-${Date.now()}`;
			await sendMessage(pageA, token);
			const threadId = await startThread(pageA, await waitForMessage(pageA, token));
			await pageA.getByRole('button', { name: 'Back to room', exact: true }).click();
			// More replies than one page (50), posted before the reader opens the thread.
			await pageA.evaluate(async ({ room, prefix }) => {
				const socket = new WebSocket(new URL('/ws', location.href).href.replace(/^http/, 'ws'));
				await new Promise<void>((resolve, reject) => {
					let sent = 0;
					const next = () => socket.send(JSON.stringify({ id: `r${sent}`, method: 'message', params: { room_id: room, body: { text: `${prefix} reply ${sent}` } } }));
					socket.onerror = () => reject(new Error('socket failed'));
					socket.onmessage = (event) => {
						const frame = JSON.parse(event.data);
						if (frame.method === 'server') socket.send(JSON.stringify({ id: 'a1', method: 'auth', params: { scheme: 'guest' } }));
						if (frame.id === 'a1') next();
						if (typeof frame.id === 'string' && frame.id.startsWith('r')) {
							sent += 1;
							if (sent < 70) next();
							else { socket.close(); resolve(); }
						}
					};
				});
			}, { room: threadId, prefix: token });

			const pageB = await reader.newPage();
			await openChat(pageB);
			await pageB.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`).click();
			const header = pageB.locator('.ap-roomhead-sub');
			const reply = (index: number) => pageB.locator('article[data-message-id]').filter({ hasText: new RegExp(`${token} reply ${index}(?!\\d)`) });
			// Only the newest page is loaded, so the thread opens at its latest reply.
			await expect(header).toHaveText('50+ replies');
			await expect(reply(69)).toBeInViewport();
			await expect(reply(0)).toHaveCount(0);
			// Reading back to the top loads the rest; the reply in view stays in view.
			const list = pageB.getByTestId('message-list');
			await list.evaluate((node) => { node.scrollTop = 0; });
			await expect(header).toHaveText('70 replies');
			await expect(reply(0)).toHaveCount(1);
			await expect(reply(20)).toBeInViewport();
		} finally {
			await Promise.all([owner.close(), reader.close()]);
		}
	});

	test('shows the jump prompt only when the latest timeline item is outside the viewport', async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 700 });
		await openChat(page);
		const token = `jump-${Date.now()}`;
		await sendMessage(page, [token, ...Array.from({ length: 40 }, (_, i) => `Intro line ${i}`)].join('\n\n'));
		const threadId = await startThread(page, await waitForMessage(page, token));
		await sendMessage(page, `${token}-reply`);
		await waitForMessage(page, `${token}-reply`);
		await page.getByRole('button', { name: 'Back to room', exact: true }).click();
		const jump = page.getByRole('button', { name: /jump to latest$/i });
		const list = page.getByTestId('message-list');
		await expect(jump).toHaveCount(0);
		// Opening a thread starts at its long intro, with the latest reply below the fold.
		await page.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`).click();
		await expect(jump).toBeVisible();
		await jump.click();
		await expect(jump).toHaveCount(0);
		const day = page.getByTestId('floating-day');
		await expect(day).not.toHaveClass(/day-float-shown/);
		await list.evaluate((node) => { node.scrollTop = 0; });
		await expect(jump).toBeVisible();
		// Scrolling back floats the day at the top, only while you're scrolling.
		await expect(day).toHaveClass(/day-float-shown/);
		await expect(day).toHaveText('Today');
		await expect(day).not.toHaveClass(/day-float-shown/, { timeout: 3000 });
		await page.setViewportSize({ width: 900, height: 1800 });
		await expect(jump).toHaveCount(0);
		await page.setViewportSize({ width: 900, height: 700 });
		await expect(jump).toBeVisible();
		await page.getByRole('button', { name: 'Back to room', exact: true }).click();
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
		const replyId = await (await waitForMessage(page, `${token}-answer`)).getAttribute('data-message-id');
		const stableTarget = page.locator(`article[data-message-id="${targetId}"]`);
		const stableReply = page.locator(`article[data-message-id="${replyId}"]`);
		const targetThreadId = await startThread(page, stableTarget);
		await expect(stableTarget).toBeVisible();
		await page.getByRole('button', { name: 'Back to room', exact: true }).click();
		await expect(stableReply.getByTestId('reply-reference')).toContainText(`${token}-target`);
		const replyThreadId = await startThread(page, stableReply);
		expect(replyThreadId).not.toBe(targetThreadId);
		// The reply leads its own thread; its quote opens the thread its target leads.
		await expect(stableReply.getByTestId('reply-reference')).toContainText(`${token}-target`);
		await stableReply.getByTestId('reply-reference').click();
		const selected = page.locator('[data-testid="thread-list"] button[data-thread][aria-current="page"]');
		await expect(selected).toHaveAttribute('data-thread', targetThreadId);
		await expect(stableTarget).toBeFocused();
		// After a reload this is a new guest, who has joined neither thread: the card joins it.
		await page.reload();
		await openThread(page, replyThreadId);
		await expect(stableReply.getByTestId('reply-reference')).toContainText(`${token}-target`);
	});

	test('keeps reply drafts and references when their target moves between a thread and its room', async ({ page }) => {
		await openChat(page);
		const token = `thread-reply-${Date.now()}`;
		await sendMessage(page, `${token}-target`);
		const target = await waitForMessage(page, `${token}-target`);
		const targetId = await target.getAttribute('data-message-id');
		const stableTarget = page.locator(`article[data-message-id="${targetId}"]`);
		const threadId = await startThread(page, stableTarget);
		const thread = page.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`);
		// A reply draft belongs to the room (or thread) it was written in.
		await (await messageAction(stableTarget, 'Reply to message')).click();
		await composer(page).fill(`${token}-answer`);
		await page.getByRole('button', { name: 'Back to room', exact: true }).click();
		await expect(page.getByTestId('reply-draft')).toHaveCount(0);
		await expect(composer(page)).toHaveText('');
		await thread.click();
		await expect(page.getByTestId('reply-draft')).toContainText(`${token}-target`);
		await expect(composer(page)).toHaveText(`${token}-answer`);
		await page.getByRole('button', { name: 'Send message', exact: true }).click();
		const reply = await waitForMessage(page, `${token}-answer`);
		await expect(reply.getByTestId('reply-reference')).toContainText(`${token}-target`);

		// A message moved out of the thread keeps every reference to it, drafts included.
		await sendMessage(page, `${token}-mover`);
		const moverId = await (await waitForMessage(page, `${token}-mover`)).getAttribute('data-message-id');
		const mover = page.locator(`article[data-message-id="${moverId}"]`);
		await (await messageAction(mover, 'Reply to message')).click();
		await sendMessage(page, `${token}-mover-answer`);
		const moverAnswer = await waitForMessage(page, `${token}-mover-answer`);
		await (await messageAction(mover, 'Reply to message')).click();
		await composer(page).fill(`${token}-unsent`);
		await moveMessage(page, mover, 'room');
		await expect(mover).toHaveCount(0);
		await expect(moverAnswer.getByTestId('reply-reference')).toContainText(`${token}-mover`);
		await expect(page.getByTestId('reply-draft')).toContainText(`${token}-mover`);
		await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
		// Its quote now crosses rooms: it opens the room and highlights the message there.
		await moverAnswer.getByTestId('reply-reference').click();
		await expect(mover).toBeVisible();
		await expect(mover).toBeFocused();
		await expect(page.getByRole('button', { name: 'Back to room', exact: true })).toHaveCount(0);
		await expect(composer(page)).toHaveText('');
		await thread.click();
		await expect(composer(page)).toHaveText(`${token}-unsent`);
		await page.getByRole('button', { name: 'Send message', exact: true }).click();
		const crossRoomReply = await waitForMessage(page, `${token}-unsent`);
		await expect(crossRoomReply.getByTestId('reply-reference')).toContainText(`${token}-mover`);
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

	test('starts a thread, keeps drafts per room, moves messages into it and back, and replays threads', async ({ browser }) => {
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

			const threadId = await startThread(pageA, rootA);
			// A thread is a room of its own, named by the server.
			expect(threadId).toMatch(/^\d+$/);
			const threadButton = pageA.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`);
			const rootB = pageB.locator(`article[data-message-id="${rootEventId}"]`);
			await expect(pageB.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`)).toBeVisible();
			await expect(rootB).toHaveCount(0);
			const roomB = pageB.getByRole('main', { name: 'Conversation' });
			const roomArticlesBefore = await roomB.locator('article[data-message-id]').count();

			await expect(pageA.locator(`article[data-message-id="${rootEventId}"]`)).toBeVisible();
			await composer(pageA).fill('draft kept in thread');
			await pageA.getByRole('button', { name: 'Back to room', exact: true }).click();
			await expect(composer(pageA)).toHaveText('');
			await composer(pageA).fill('draft kept in room');
			await threadButton.click();
			await expect(composer(pageA)).toHaveText('draft kept in thread');

			await sendMessage(pageA, replyText);
			const replyId = await (await waitForMessage(pageA, replyText)).getAttribute('data-message-id');
			const replyA = pageA.locator(`article[data-message-id="${replyId}"]`);
			await expect(pageB.locator(`article[data-message-id="${replyId}"]`)).toHaveCount(0);
			expect(await roomB.locator('article[data-message-id]').count()).toBe(roomArticlesBefore);

			// B has not joined A's thread: its card joins it, and only then does it deliver.
			const threadButtonB = pageB.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`);
			await expect(threadButtonB).toHaveCount(0);
			await openThread(pageB, threadId);
			await expect(await waitForMessage(pageB, replyText)).toContainText(replyText);
			await expect(rootB).toBeVisible();
			await expect(threadButtonB.locator('small')).toHaveText('1');

			// A room message moves into the thread (with its reactions) and back out.
			await pageA.getByRole('button', { name: 'Back to room', exact: true }).click();
			await expect(composer(pageA)).toHaveText('draft kept in room');
			await sendMessage(pageA, `${rootText}-mover`);
			const moverId = await (await waitForMessage(pageA, `${rootText}-mover`)).getAttribute('data-message-id');
			const moverA = pageA.locator(`article[data-message-id="${moverId}"]`);
			const moverB = pageB.locator(`article[data-message-id="${moverId}"]`);
			await reactTo(moverA, '👀');
			await expect(reactionChip(moverA, '👀')).toHaveText('👀1');
			await expect(moverB).toHaveCount(0);
			await moveMessage(pageA, moverA, rootText);
			await expect(moverA).toHaveCount(0);
			await expect(moverB).toBeVisible();
			await expect(reactionChip(moverB, '👀')).toHaveText('👀1');
			await expect(threadButtonB.locator('small')).toHaveText('2');
			await threadButton.click();
			await expect(moverA).toBeVisible();
			await moveMessage(pageA, moverA, 'room');
			await expect(moverA).toHaveCount(0);
			await expect(moverB).toHaveCount(0);
			await expect(threadButtonB.locator('small')).toHaveText('1');
			await pageA.getByRole('button', { name: 'Back to room', exact: true }).click();
			await expect(moverA).toBeVisible();
			await expect(reactionChip(moverA, '👀')).toHaveText('👀1');

			await contextA.setOffline(true);
			await pageA.reload({ waitUntil: 'commit', timeout: 3_000 }).catch(() => undefined);
			await contextA.setOffline(false);
			await pageA.reload({ waitUntil: 'domcontentloaded' });
			await expect(pageA.getByTestId('connection-status')).toHaveText('Connected', { timeout: 20_000 });
			await expect(pageA.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`)).toBeVisible();
			await expect(replyA).toHaveCount(0);
			await expect(pageA.locator(`article[data-message-id="${rootEventId}"]`)).toHaveCount(0);
			await expect(moverA).toBeVisible();
			// The reload made A a new guest, who joins the thread from its card.
			await openThread(pageA, threadId);
			await expect(replyA).toBeVisible();
			await expect(pageA.locator(`article[data-message-id="${rootEventId}"]`)).toBeVisible();
			await expect(moverA).toHaveCount(0);
			await expect(threadButton.locator('small')).toHaveText('1');
		} finally {
			await contextA.setOffline(false).catch(() => undefined);
			await Promise.all([contextA.close(), contextB.close()]);
		}
	});

	test('reacts across clients, toggles reactions off, replays them, and hides them on tombstones', async ({ browser }) => {
		const contextA = await browser.newContext();
		const contextB = await browser.newContext();
		try {
			const pageA = await contextA.newPage();
			const pageB = await contextB.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);
			const token = `react-${Date.now()}`;
			await sendMessage(pageA, token);
			const messageId = await (await waitForMessage(pageA, token)).getAttribute('data-message-id');
			const onA = pageA.locator(`article[data-message-id="${messageId}"]`);
			const onB = pageB.locator(`article[data-message-id="${messageId}"]`);
			await expect(onB).toBeVisible();

			await reactTo(onB, '👍');
			const chipA = reactionChip(onA, '👍');
			const chipB = reactionChip(onB, '👍');
			await expect(chipA).toHaveText('👍1');
			await expect(chipA).toHaveAttribute('aria-pressed', 'false');
			await expect(chipB).toHaveAttribute('aria-pressed', 'true');
			await expect(chipB).toHaveAttribute('title', 'You reacted with 👍');
			// Clicking someone else's chip adds your reaction; the count updates everywhere.
			await chipA.click();
			await expect(chipB).toHaveText('👍2');
			await expect(chipA).toHaveAttribute('aria-pressed', 'true');
			await expect(chipA).toHaveAttribute('title', /^You and .+ reacted with 👍$/);
			// Clicking your own chip takes it back.
			await chipB.click();
			await expect(chipA).toHaveText('👍1');
			await expect(chipB).toHaveAttribute('aria-pressed', 'false');
			await expect(chipA).toHaveAttribute('title', 'You reacted with 👍');
			await reactTo(onB, '🎉');
			await expect(reactionChip(onA, '🎉')).toHaveText('🎉1');

			// A new reader replays reactions with the room's history.
			const pageC = await contextB.newPage();
			await openChat(pageC);
			const onC = pageC.locator(`article[data-message-id="${messageId}"]`);
			await expect(reactionChip(onC, '👍')).toHaveText('👍1');
			await expect(reactionChip(onC, '🎉')).toHaveText('🎉1');
			await chipA.click();
			await expect(chipB).toHaveCount(0);
			await expect(reactionChip(onC, '👍')).toHaveCount(0);
			await expect(reactionChip(onC, '🎉')).toHaveText('🎉1');

			// Tombstones hide their reactions.
			await deleteMessage(pageA, onA);
			await waitForDeletedMessage(pageB, messageId!);
			await expect(onA.getByTestId('reaction-chip')).toHaveCount(0);
			await expect(onB.getByTestId('reaction-chip')).toHaveCount(0);
			await expect(onC.getByTestId('reaction-chip')).toHaveCount(0);
			await onB.hover();
			await expect(onB.getByRole('button', { name: 'React', exact: true })).toHaveCount(0);
		} finally {
			await Promise.all([contextA.close(), contextB.close()]);
		}
	});

	test('mentions someone by name or user_id as a name chip that is sent as their user_id, and pings only them', async ({ browser }) => {
		const writer = await browser.newContext();
		const named = await browser.newContext();
		try {
			const pageA = await writer.newPage();
			const pageB = await named.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);
			const handle = `dana-${Date.now().toString(36)}`;
			await setDisplayName(pageB, handle);
			const id = await userIdOf(pageB);
			await sendMessage(pageB, `${handle} is here`);
			await waitForMessage(pageA, `${handle} is here`);

			// Typing `@` opens the picker on the room's people; picking puts in a chip with their name, backed by their user_id.
			const field = composer(pageA);
			await field.fill('Handing this to @dana');
			const picker = pageA.getByTestId('mention-picker');
			await expect(picker.getByRole('option', { name: new RegExp(handle) })).toBeVisible();
			await expect(picker.locator('.ap-mpick-hit').first()).toHaveText('dana');
			await field.press('Tab');
			const chip = field.locator('.ap-mention');
			await expect(chip).toHaveText(`@${handle}`);
			await expect(chip).toHaveAttribute('data-user-id', id);
			await expect(field).toHaveText(`Handing this to @${handle} `);
			await expect(picker).toHaveCount(0);

			// A finished `@name` or `@user_id` collapses into the same chip; unknown handles stay text.
			await field.fill(`Handing this to @${handle} and @${id} and @nobody-here`);
			await expect(field.locator('.ap-mention')).toHaveCount(2);
			await expect(field.locator(`.ap-mention[data-user-id="${id}"]`)).toHaveCount(2);
			await expect(field).toHaveText(`Handing this to @${handle} and @${handle} and @nobody-here`);
			await field.fill(`cc @${handle}`);
			await expect(field.locator('.ap-mention')).toHaveCount(0);
			await field.fill(`Handing this to @${handle}, cc @${id}`);
			await expect(field.locator('.ap-mention')).toHaveCount(1);
			await pageA.getByRole('button', { name: 'Send message', exact: true }).click();
			await expect(field).toHaveText('');
			const sent = await waitForMessage(pageA, 'Handing this to');
			// Both mentions went out as `@user_id` (the one ending the draft chips on send); the writer isn't the one named, so no tint.
			await expect(sent.locator(`.ap-mention[data-user-id="${id}"]`)).toHaveText([`@${handle}`, `@${handle}`]);
			await expect(sent.locator('.ap-mention-me')).toHaveCount(0);
			await expect(sent).not.toHaveClass(/ap-msg-mention/);
			const received = await waitForMessage(pageB, 'Handing this to');
			await expect(received.locator('.ap-mention-me')).toHaveText([`@${handle}`, `@${handle}`]);
			await expect(received).toHaveClass(/ap-msg-mention/);

			// A handle inside code is code, and a message you send yourself never pings you.
			await sendMessage(pageB, `\`@${id}\` stays code`);
			const quoted = await waitForMessage(pageB, 'stays code');
			await expect(quoted.locator('.ap-mention')).toHaveCount(0);
			await expect(quoted).not.toHaveClass(/ap-msg-mention/);
		} finally {
			await Promise.all([writer.close(), named.close()]);
		}
	});

	test('counts unread arrivals in the tab title until you read them', async ({ browser }) => {
		const writer = await browser.newContext();
		const reader = await browser.newContext();
		try {
			const pageA = await writer.newPage();
			const pageB = await reader.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);
			await pageB.setViewportSize({ width: 900, height: 700 });
			const token = `unread-${Date.now().toString(36)}`;
			await sendMessage(pageA, [`${token}-intro`, ...Array.from({ length: 40 }, (_, line) => `Intro line ${line}`)].join('\n\n'));
			await sendMessage(pageA, `${token}-latest`);
			await waitForMessage(pageB, `${token}-latest`);
			await expect(pageB).toHaveTitle('Apron');

			await pageB.getByTestId('message-list').evaluate((node) => { node.scrollTop = 0; });
			await expect(pageB.getByTestId('jump-button')).toBeVisible();
			await sendMessage(pageA, `${token}-one`);
			await sendMessage(pageA, `${token}-two`);
			await expect(pageB).toHaveTitle('(2) Apron');
			// Short times carry the exact local time on hover, the grouped follower's too.
			const exact = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
			await expect((await waitForMessage(pageB, `${token}-intro`)).locator('.ap-msg-meta time')).toHaveAttribute('title', exact);
			await expect((await waitForMessage(pageB, `${token}-two`)).locator('time.ap-msg-hovertime')).toHaveAttribute('title', exact);
			await pageB.getByTestId('jump-button').click();
			await expect(pageB).toHaveTitle('Apron');
		} finally {
			await Promise.all([writer.close(), reader.close()]);
		}
	});

	test('chimes and flashes the tab title for a mention while the window is in the background', async ({ browser }) => {
		const writer = await browser.newContext();
		const named = await browser.newContext();
		try {
			const pageA = await writer.newPage();
			const pageB = await named.newPage();
			// Count the chime's tones instead of playing them.
			await pageB.addInitScript(() => {
				(window as any).tones = 0;
				class FakeAudio {
					state = 'running';
					currentTime = 0;
					destination = {};
					resume() { return Promise.resolve(); }
					createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (node: unknown) => node }; }
					createOscillator() {
						(window as any).tones++;
						return { type: '', frequency: { value: 0 }, connect: (node: unknown) => node, start() {}, stop() {} };
					}
				}
				(window as any).AudioContext = FakeAudio;
			});
			await Promise.all([openChat(pageA), openChat(pageB)]);
			const id = await userIdOf(pageB);
			const token = `attention-${Date.now().toString(36)}`;

			// While focused, a mention neither chimes nor flashes.
			await sendMessage(pageA, `@${id} ${token} focused`);
			await waitForMessage(pageB, `${token} focused`);
			await pageB.waitForTimeout(300);
			expect(await pageB.evaluate(() => (window as any).tones)).toBe(0);
			await expect(pageB).toHaveTitle('Apron');

			await pageB.evaluate(() => window.dispatchEvent(new Event('blur')));
			await sendMessage(pageA, `@${id} ${token} away`);
			await expect(pageB).toHaveTitle('@ You were mentioned');
			expect(await pageB.evaluate(() => (window as any).tones)).toBeGreaterThan(0);
			await pageB.evaluate(() => window.dispatchEvent(new Event('focus')));
			await expect(pageB).toHaveTitle('Apron');
		} finally {
			await Promise.all([writer.close(), named.close()]);
		}
	});

	test('badges a thread in the sidebar when you are mentioned in it elsewhere', async ({ browser }) => {
		const writer = await browser.newContext();
		const named = await browser.newContext();
		try {
			const pageA = await writer.newPage();
			const pageB = await named.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);
			const id = await userIdOf(pageB);
			const token = `threadping-${Date.now().toString(36)}`;
			await sendMessage(pageA, `${token}-root`);
			const threadId = await startThread(pageA, await waitForMessage(pageA, `${token}-root`));
			// B joins the thread (its card), then goes back to the room.
			await openThread(pageB, threadId);
			await pageB.getByRole('button', { name: 'Back to room', exact: true }).click();
			const row = pageB.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`);
			await expect(row).toBeVisible();
			await expect(row.getByTestId('thread-mentions')).toHaveCount(0);

			// B stays in the room; the mention lands in the thread.
			await sendMessage(pageA, `@${id} ${token} please look`);
			await expect(row.getByTestId('thread-mentions')).toHaveText('@');
			await row.click();
			await waitForMessage(pageB, `${token} please look`);
			await expect(row.getByTestId('thread-mentions')).toHaveCount(0);
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
			const id = await userIdOf(pageB);

			await sendMessage(pageA, [`${handle}-root`, ...Array.from({ length: 40 }, (_, line) => `Intro line ${line}`)].join('\n\n'));
			const threadId = await startThread(pageA, await waitForMessage(pageA, `${handle}-root`));
			await sendMessage(pageA, `${handle}-first-reply`);
			await waitForMessage(pageA, `${handle}-first-reply`);

			await openThread(pageB, threadId);
			await waitForMessage(pageB, `${handle}-first-reply`);
			await pageB.getByTestId('message-list').evaluate((node) => { node.scrollTop = 0; });
			await expect(pageB.getByTestId('jump-button')).toHaveAccessibleName('Jump to latest');
			await expect(pageB.locator('.ap-jumpfab')).toBeVisible();

			// The mention arrives out of sight: the bar turns rust and offers the mention itself.
			await sendMessage(pageA, `@${id} can you check the migration logs?`);
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
			expect(threadId).toMatch(/^\d+$/);
			await expect(threadTab).toContainText(`${token}-one`);
			await expect(pageA.getByTestId('selection-bar')).toHaveCount(0);
			for (const suffix of ['one', 'two', 'three']) await expect(await waitForMessage(pageA, `${token}-${suffix}`)).toBeVisible();

			// The room shows the thread's card where the selection began; the other reader sees the same.
			await pageA.getByRole('button', { name: 'Back to room', exact: true }).click();
			await expect(pageA.locator(`article[data-message-id="${firstId}"]`)).toHaveCount(0);
			await expect(pageA.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`)).toBeVisible();
			await expect(pageB.locator(`article[data-message-id="${firstId}"]`)).toHaveCount(0);
			const threadButtonB = pageB.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`);
			await openThread(pageB, threadId);
			for (const suffix of ['one', 'three']) await expect(await waitForMessage(pageB, `${token}-${suffix}`)).toBeVisible();
			await expect(threadButtonB.locator('small')).toHaveText('3');
		} finally {
			await Promise.all([mover.close(), reader.close()]);
		}
	});
});

test.describe('full emoji picker', () => {
	test('inserts an emoji at the composer caret, keeps mention chips, and sends it', async ({ page }) => {
		const offsite = recordOffsiteRequests(page);
		await openChat(page);
		const me = await userIdOf(page);
		const token = `emoji-${Date.now()}`;
		const field = composer(page);
		await field.click();
		await page.keyboard.type(`${token} @${me} party time`);
		await expect(field.locator('.ap-mention')).toHaveCount(1);
		// The caret goes back before "time"; that is where the emoji lands.
		for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft');

		const button = page.getByRole('button', { name: 'Insert emoji', exact: true });
		await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
		await expect(button).toHaveAttribute('aria-expanded', 'false');
		await button.click();
		await expect(button).toHaveAttribute('aria-expanded', 'true');
		const picker = emojiPicker(page);
		await expect(picker).toHaveAttribute('data-state', 'ready');
		// Search takes focus, and the popover opens inside the viewport, above the composer.
		await expect(picker.locator('em-emoji-picker input[type="search"]')).toBeFocused();
		const bounds = (await picker.boundingBox())!;
		const composerBounds = (await field.boundingBox())!;
		const viewport = page.viewportSize()!;
		expect(bounds.y).toBeGreaterThanOrEqual(0);
		expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
		expect(bounds.y + bounds.height).toBeLessThanOrEqual(composerBounds.y);
		// Its colors are the app's: emoji-mart's accent is the rust accent.
		const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
		const rgb = [1, 3, 5].map((at) => parseInt(accent.slice(at, at + 2), 16)).join(', ');
		expect(await picker.locator('em-emoji-picker').evaluate((element) => (element as HTMLElement).style.getPropertyValue('--rgb-accent'))).toBe(rgb);

		await pickFromEmojiPicker(page, 'tada', '🎉');
		await expect(button).toHaveAttribute('aria-expanded', 'false');
		// Focus is back in the field with the caret after the emoji: typing carries on from there.
		await expect(field).toBeFocused();
		await page.keyboard.type(' ');
		await expect(field.locator('.ap-mention')).toHaveCount(1);

		// Escape closes the picker and returns focus to its button; a press outside closes it too.
		await button.click();
		await expect(picker).toHaveAttribute('data-state', 'ready');
		await page.keyboard.press('Escape');
		await expect(picker).toHaveCount(0);
		await expect(button).toBeFocused();
		await button.click();
		await expect(picker).toBeVisible();
		await page.getByRole('main', { name: 'Conversation' }).getByRole('heading', { name: 'General', exact: true }).click();
		await expect(picker).toHaveCount(0);

		await page.getByRole('button', { name: 'Send message', exact: true }).click();
		const message = await waitForMessage(page, `${token} `);
		await expect(message.locator('.ap-msg-text')).toHaveText(new RegExp(`^${token} @\\S+ party 🎉 time\\s*$`));
		await expect(message.locator('.ap-mention')).toHaveCount(1);
		expect(offsite).toEqual([]);
	});

	test('reacts with any emoji through the full picker, and toggles it back', async ({ page }) => {
		const offsite = recordOffsiteRequests(page);
		await openChat(page);
		const token = `emoji-react-${Date.now()}`;
		await sendMessage(page, token);
		const messageId = await (await waitForMessage(page, token)).getAttribute('data-message-id');
		const message = page.locator(`article[data-message-id="${messageId}"]`);

		await (await messageAction(message, 'React')).click();
		const palette = message.getByTestId('reaction-palette');
		// The quick palette stays as it was, with More emoji at the end of it.
		await expect(palette.getByRole('button', { name: /^React with / })).toHaveCount(8);
		const more = palette.getByRole('button', { name: 'More emoji', exact: true });
		await expect(more).toHaveAttribute('aria-expanded', 'false');
		await more.click();
		await expect(more).toHaveAttribute('aria-expanded', 'true');
		const picker = emojiPicker(page);
		await expect(picker).toHaveAttribute('data-state', 'ready');
		const bounds = (await picker.boundingBox())!;
		const viewport = page.viewportSize()!;
		expect(bounds.x).toBeGreaterThanOrEqual(0);
		expect(bounds.y).toBeGreaterThanOrEqual(0);
		expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
		expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
		// Escape closes only the picker, back on the button that opened it.
		await page.keyboard.press('Escape');
		await expect(picker).toHaveCount(0);
		await expect(more).toBeFocused();
		await expect(palette).toBeVisible();

		await more.click();
		await pickFromEmojiPicker(page, 'avocado', '🥑');
		await expect(palette).toHaveCount(0);
		const chip = reactionChip(message, '🥑');
		await expect(chip).toHaveText('🥑1');
		await expect(chip).toHaveAttribute('aria-pressed', 'true');

		// Your set grows: a quick pick keeps the picked one, and picking it again takes it back.
		await reactTo(message, '👍');
		await expect(message.getByTestId('reaction-chip')).toHaveCount(2);
		await (await messageAction(message, 'React')).click();
		await palette.getByRole('button', { name: 'More emoji', exact: true }).click();
		await pickFromEmojiPicker(page, 'avocado', '🥑');
		await expect(chip).toHaveCount(0);
		await expect(reactionChip(message, '👍')).toHaveText('👍1');
		expect(offsite).toEqual([]);
	});
});
