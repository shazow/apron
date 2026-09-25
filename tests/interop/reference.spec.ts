import { deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { composer, messageAction, messageByText, openChat, openThread, sendMessage, setDisplayName, startThread, userIdOf, waitForMessage } from './test-helpers';

/** The dev server proxies the Go server, so URLs the server mints use this host and load same-origin. */
const PROXIED_WS = 'ws://127.0.0.1:5173/ws';

/** A solid-colour PNG, built by hand so the test needs no image library. */
function png(width: number, height: number): Buffer {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (bytes: Buffer) => {
		let c = 0xffffffff;
		for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([length, body, sum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xc8)])));
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** A guest speaking the protocol directly, for what the web client doesn't author (streams, raw embeds). */
async function rawGuest(): Promise<{ request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>; close: () => void }> {
	const socket = new WebSocket(PROXIED_WS);
	const waiting = new Map<string, (frame: Record<string, unknown>) => void>();
	socket.addEventListener('message', (event) => {
		const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
		if (typeof frame.id === 'string') waiting.get(frame.id)?.(frame);
	});
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', reject, { once: true });
	});
	let next = 0;
	const request = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
		const id = `raw-${next++}`;
		waiting.set(id, (frame) => (frame.error ? reject(new Error(JSON.stringify(frame.error))) : resolve(frame.result as Record<string, unknown>)));
		socket.send(JSON.stringify({ method, id, params }));
	});
	await request('auth', { scheme: 'guest', name: 'Raw bot' });
	return { request, close: () => socket.close() };
}

function embedOf(page: Page, text: string) {
	return page.locator('article[data-message-id]').filter({ hasText: text }).locator('.ap-msg-embeds');
}

test.describe('reference features against the Go server', () => {
	test('sends images and files as uploads and shows them hosted by the server', async ({ browser }) => {
		const sender = await browser.newContext();
		const reader = await browser.newContext();
		try {
			const pageA = await sender.newPage();
			const pageB = await reader.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);
			const token = `upload-${Date.now().toString(36)}`;
			await composer(pageA).fill(`${token} chart`);
			await pageA.getByTestId('attach-input').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: png(48, 24) });

			// The server hosts the file and describes it with og.image; both sides show the picture.
			for (const page of [pageA, pageB]) {
				const image = embedOf(page, `${token} chart`).locator('figure.ap-embed-figure img.ap-embed-media');
				await expect(image).toBeVisible();
				await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(48);
				await expect(embedOf(page, `${token} chart`).locator('figcaption')).toHaveText('chart.png');
			}
			await expect(composer(pageA)).toHaveText('');

			// A file without a preview is a file card linking to the download.
			await pageA.getByTestId('attach-input').setInputFiles({ name: `${token}.txt`, mimeType: 'text/plain', buffer: Buffer.from('notes') });
			const card = pageB.locator('a.ap-embed-file').filter({ hasText: `${token}.txt` });
			await expect(card).toBeVisible();
			const href = await card.getAttribute('href');
			expect(href).toMatch(/^http:\/\/127\.0\.0\.1:5173\/files\//);
			expect(await (await pageB.request.get(href!)).text()).toBe('notes');
		} finally {
			await Promise.all([sender.close(), reader.close()]);
		}
	});

	test('streams live text into a message, then keeps the finished text', async ({ page }) => {
		await openChat(page);
		const token = `stream-${Date.now().toString(36)}`;
		const bot = await rawGuest();
		try {
			const result = await bot.request('message', { room_id: 'general', body: { text: `${token} build`, embeds: [{ kind: 'stream', format: 'terminal' }] } });
			const writeUrl = (result.embeds as Array<{ write_url: string }>)[0].write_url;
			let push!: (chunk: string) => void;
			let finish!: () => void;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
					finish = () => controller.close();
				}
			});
			const writing = fetch(writeUrl, { method: 'PUT', body, duplex: 'half' } as RequestInit & { duplex: 'half' });
			const stream = embedOf(page, `${token} build`).getByTestId('stream-embed');
			await expect(stream).toBeVisible();
			push('$ make deploy\n');
			await expect(stream.locator('pre')).toContainText('$ make deploy');
			await expect(stream.locator('.ap-embed-livebadge')).toHaveText('Live');
			push('pushing image… ok\n');
			await expect(stream.locator('pre')).toContainText('pushing image… ok');
			// Terminal output shows colors without their escapes, and a carriage return overwrites the line.
			push('\u001b[32mupload  40%');
			await expect(stream.locator('pre .ap-term-fg2')).toHaveText('upload  40%');
			push('\rupload 100%\u001b[0m\n');
			await expect(stream.locator('pre .ap-term-fg2')).toHaveText('upload 100%');
			finish();
			expect((await writing).status).toBe(204);
			// The finishing snapshot carries the kept text in place of the url.
			await expect(stream.locator('.ap-embed-streamhead')).toContainText('Finished');
			await expect(stream.locator('pre')).toHaveText('$ make deploy\npushing image… ok\nupload 100%\n');
			await expect(stream.locator('pre .ap-term-fg2')).toHaveText('upload 100%');
		} finally {
			bot.close();
		}
	});

	test('renders iframe, html, and unknown embeds by kind', async ({ page }) => {
		await openChat(page);
		const token = `embeds-${Date.now().toString(36)}`;
		const bot = await rawGuest();
		try {
			await bot.request('message', { room_id: 'general', body: { text: token, embeds: [
				{ kind: 'iframe', url: 'https://example.com/term', height: 900, title: 'Terminal' },
				{ kind: 'html', html: '<table><tr><td><b>green</b></td></tr></table><img src=x onerror="window.pwned=1"><script>window.pwned=1</script>' },
				{ kind: 'poll', url: 'https://example.com/poll/7' }
			] } });
			const embeds = embedOf(page, token);
			// Live views stay paused until asked for, then load sandboxed and clamped.
			await embeds.getByRole('button', { name: 'Load live view', exact: true }).click();
			const frame = embeds.locator('iframe.ap-embed-frame');
			await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
			expect(await frame.evaluate((node) => node.getBoundingClientRect().height)).toBeLessThanOrEqual(480);
			// HTML is sanitized before insertion.
			await expect(embeds.locator('.ap-embed-html b')).toHaveText('green');
			await expect(embeds.locator('.ap-embed-html script')).toHaveCount(0);
			expect(await page.evaluate(() => (window as { pwned?: number }).pwned)).toBeUndefined();
			// An unknown kind is a fallback card with its link.
			await expect(embeds.locator('.ap-embed-fallback .ap-embed-kind')).toHaveText('poll');
			await expect(embeds.locator('.ap-embed-fallback a')).toHaveAttribute('href', 'https://example.com/poll/7');
		} finally {
			bot.close();
		}
	});

	test('uploads an avatar and shows renames and avatars on earlier messages', async ({ browser }) => {
		const owner = await browser.newContext();
		const reader = await browser.newContext();
		try {
			const pageA = await owner.newPage();
			const pageB = await reader.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);
			const token = `avatar-${Date.now().toString(36)}`;
			await sendMessage(pageA, `${token} before`);
			const earlier = await waitForMessage(pageB, `${token} before`);

			await pageA.getByRole('button', { name: /^Your profile on/ }).click();
			const dialog = pageA.getByRole('dialog', { name: 'Edit profile', exact: true });
			await dialog.getByTestId('avatar-input').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png(16, 16) });
			// The server sets the avatar and sends `user`; it shows on the earlier message too.
			await expect(earlier.locator('.ap-msg-gutter img.ap-avatar')).toBeVisible();
			await expect(dialog.getByTestId('remove-avatar')).toBeVisible();
			await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

			await setDisplayName(pageA, `${token}-renamed`);
			await expect(earlier.locator('.ap-msg-sender')).toHaveText(`${token}-renamed`);

			await pageA.getByRole('button', { name: /^Your profile on/ }).click();
			await dialog.getByTestId('remove-avatar').click();
			await expect(earlier.locator('.ap-msg-gutter img.ap-avatar')).toHaveCount(0);
			await expect(earlier.locator('.ap-msg-gutter span.ap-avatar')).toBeVisible();
		} finally {
			await Promise.all([owner.close(), reader.close()]);
		}
	});

	test('runs commands from the composer, with their replies and errors shown only to you', async ({ page }) => {
		await openChat(page);
		const field = composer(page);
		const run = page.getByRole('button', { name: 'Run command', exact: true });
		await field.fill('/help');
		await expect(page.getByTestId('command-tag')).toHaveText('Command');
		await run.click();
		await expect(field).toHaveText('');
		// The server's reply is a @private notice: never stored, marked as yours alone.
		const help = page.getByTestId('notice').filter({ hasText: '/avatar' }).last();
		await expect(help).toBeVisible();
		await expect(help).toHaveClass(/ap-msg-private/);
		await expect(help).toContainText('Only you');
		await expect(help).not.toHaveAttribute('data-message-id');

		// A failed command shows its error the same way and gives the draft back.
		await field.fill('/frobnicate now');
		await run.click();
		await expect(page.getByTestId('notice').filter({ hasText: 'Unknown command' }).last()).toBeVisible();
		await expect(field).toHaveText('/frobnicate now');

		// `//` posts a message that starts with one slash.
		const token = `slash-${Date.now().toString(36)}`;
		await field.fill(`//${token} is a path`);
		await expect(page.getByTestId('command-tag')).toHaveCount(0);
		await page.getByRole('button', { name: 'Send message', exact: true }).click();
		const posted = await waitForMessage(page, `/${token} is a path`);
		await expect(posted).not.toContainText(`//${token}`);

		// `/nick` is the client's own: a `me` request. The header then shows Name (@user_id).
		const handle = `nick-${Date.now().toString(36)}`;
		await field.fill(`/nick ${handle}`);
		await run.click();
		await expect(page.getByRole('button', { name: new RegExp(`^Your profile on .*: ${handle}\\.`) })).toBeVisible();
		const id = await userIdOf(page);
		// The earlier message renders with the latest name; notices above it began its group.
		await expect(posted.locator('.ap-msg-sender')).toHaveText(handle);
		await expect(posted.getByTestId('sender-handle')).toHaveText(`@${id}`);
		await expect(messageByText(page, `/${token} is a path`)).toBeVisible();
	});

	test('leaves and rejoins rooms and threads from room_list', async ({ page }) => {
		await openChat(page);
		const token = `rooms-${Date.now().toString(36)}`;
		await sendMessage(page, `${token} root`);
		const threadId = await startThread(page, await waitForMessage(page, `${token} root`));
		page.on('dialog', (dialog) => dialog.accept());
		const row = page.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"]`);
		const card = page.locator(`[data-testid="thread-card"][data-thread="${threadId}"]`);

		// Leaving a thread removes its row; its card stays in the room, and More threads… lists it to join.
		await page.getByTestId('leave-room').click();
		await expect(row).toHaveCount(0);
		await expect(card).toBeVisible();
		await page.getByTestId('more-threads').click();
		await page.locator(`[data-join="${threadId}"]`).click();
		await expect(page.locator(`[data-testid="thread-list"] button[data-thread="${threadId}"][aria-current="page"]`)).toHaveCount(1);
		await page.getByRole('button', { name: 'Back to room', exact: true }).click();

		// Threads are rooms of their own: leaving General keeps the thread, listed on its own.
		await page.getByTestId('leave-room').click();
		await expect(page.getByTestId('room-list').locator(`button[data-room="general"]`)).toHaveCount(0);
		await expect(page.getByTestId('room-list').locator(`button[data-room="${threadId}"]`)).toBeVisible();
		await page.getByTestId('browse-rooms').click();
		await expect(page.getByTestId('room-directory')).toContainText('Most active rooms');
		await page.getByTestId('room-directory').locator('[data-join="general"]').click();
		await expect(page.getByRole('main', { name: 'Conversation' }).getByRole('heading', { name: 'General', exact: true })).toBeVisible();
		// The thread is still joined: its row is back under General, beside its card.
		await expect(card).toBeVisible();
		await expect(row).toBeVisible();
		await openThread(page, threadId);
	});

	test('marks where you stopped reading with a New divider and links room mentions', async ({ browser }) => {
		const writer = await browser.newContext();
		const reader = await browser.newContext();
		try {
			const pageA = await writer.newPage();
			const pageB = await reader.newPage();
			await Promise.all([openChat(pageA), openChat(pageB)]);
			const token = `read-${Date.now().toString(36)}`;
			await sendMessage(pageA, `${token} seen`);
			await waitForMessage(pageB, `${token} seen`);
			const threadId = await startThread(pageA, await waitForMessage(pageA, `${token} seen`));

			// The reader goes to the thread; what arrives in General meanwhile is new to them.
			await openThread(pageB, threadId);
			await pageA.getByRole('button', { name: 'Back to room', exact: true }).click();
			await sendMessage(pageA, `${token} unread in @general`);
			await pageB.getByRole('button', { name: 'Back to room', exact: true }).click();
			const unread = await waitForMessage(pageB, `${token} unread`);
			const divider = pageB.getByTestId('new-divider');
			await expect(divider).toHaveText('New');
			expect(await divider.evaluate((node, id) => node.nextElementSibling?.getAttribute('data-message-id') === id, await unread.getAttribute('data-message-id'))).toBe(true);
			// `@general` names the room: a link, not a person.
			await expect(unread.locator('button.ap-mention-room[data-room-id="general"]')).toHaveText('General');

			// Mentions name a user_id; the chip shows their current name.
			await setDisplayName(pageB, `${token}-reader`);
			const id = await userIdOf(pageB);
			await sendMessage(pageA, `${token} ping @${id}`);
			const ping = await waitForMessage(pageB, `${token} ping`);
			await expect(ping.locator('.ap-mention-me')).toHaveText(`@${token}-reader`);
			await (await messageAction(ping, 'Reply to message')).click();
		} finally {
			await Promise.all([writer.close(), reader.close()]);
		}
	});
});
