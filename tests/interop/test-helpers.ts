import { expect, type Locator, type Page } from '@playwright/test';

export function composer(page: Page): Locator {
	return page.getByRole('textbox', { name: 'Message', exact: true });
}

export async function openChat(page: Page): Promise<void> {
	await page.goto('/');
	await page.waitForLoadState('domcontentloaded');
	await expect(page.getByRole('main', { name: 'Conversation' }).getByRole('heading', { name: 'General', exact: true })).toBeVisible();
	await expect(page.getByTestId('connection-status')).toHaveText('Connected');
	await expect(composer(page)).toBeVisible();
	await expect(composer(page)).toBeEnabled();
}

export async function sendMessage(page: Page, text: string): Promise<void> {
	await composer(page).fill(text);
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
}

export function messageByText(page: Page, text: string): Locator {
	return page.locator('article[data-message-id]').filter({ hasText: text }).first();
}

export async function waitForMessage(page: Page, text: string): Promise<Locator> {
	const message = messageByText(page, text);
	await expect(message, `message did not appear: ${text}`).toBeVisible();
	return message;
}

export async function waitForDeletedMessage(page: Page, eventId: string): Promise<Locator> {
	const message = page.locator(`article[data-message-id="${eventId}"]`);
	await expect(message, `deleted message did not appear for message ${eventId}`).toBeVisible();
	await expect(message.getByText('Message deleted', { exact: true })).toBeVisible();
	return message;
}

/**
 * The message action toolbar shows on hover or focus, so reveal it before clicking. Focus keeps
 * it up (`:focus-within`) even when the pane moves under the pointer, as it does while a room's
 * history and thread cards fill in, or when a tall message has to be scrolled to its toolbar.
 */
export async function messageAction(message: Locator, name: string): Promise<Locator> {
	await message.hover();
	await message.focus();
	const button = message.getByRole('button', { name, exact: true });
	await expect(button).toBeVisible();
	return button;
}

/** Opens the toolbar's "More" menu, where Select and Delete live. */
export async function moreAction(message: Locator, name: string): Promise<Locator> {
	await (await messageAction(message, 'More actions')).click();
	return message.getByRole('button', { name, exact: true });
}

export async function editMessage(message: Locator, text: string): Promise<void> {
	await (await messageAction(message, 'Edit message')).click();
	const editor = message.getByRole('textbox', { name: 'Edit message', exact: true });
	await expect(editor).toBeVisible();
	await editor.fill(text);
	await message.getByRole('button', { name: 'Save changes', exact: true }).click();
}

export async function deleteMessage(page: Page, message: Locator): Promise<void> {
	page.once('dialog', (dialog) => dialog.accept());
	await (await moreAction(message, 'Delete message')).click();
}

/** Sets the handle the server knows you by, through the profile editor. */
export async function setDisplayName(page: Page, name: string): Promise<void> {
	await page.getByRole('button', { name: /^Your profile on/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Edit profile', exact: true });
	await dialog.getByTestId('display-name-input').fill(name);
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('button', { name: new RegExp(`^Your profile on .*: ${name}\\.`) })).toBeVisible();
}

/** Picks one message with a shift-click and moves it through the selection bar: to a thread by title, or back to the room. */
export async function moveMessage(page: Page, message: Locator, destination: string | 'room'): Promise<void> {
	await message.click({ modifiers: ['Shift'] });
	const bar = page.getByTestId('selection-bar');
	await expect(bar).toContainText('1 message selected');
	await bar.getByRole('button', { name: 'Move to thread ▾', exact: true }).click();
	await bar.getByRole('option', { name: destination === 'room' ? 'Move to room' : destination, exact: true }).click();
	await expect(bar).toHaveCount(0);
}

/** Opens the React palette from a message's toolbar and toggles one emoji. */
export async function reactTo(message: Locator, emoji: string): Promise<void> {
	await (await messageAction(message, 'React')).click();
	const palette = message.getByTestId('reaction-palette');
	await expect(palette).toBeVisible();
	await palette.getByRole('button', { name: `React with ${emoji}`, exact: true }).click();
	await expect(palette).toHaveCount(0);
}

/** The reaction chip for one emoji under a message. */
export function reactionChip(message: Locator, emoji: string): Locator {
	return message.locator(`[data-testid="reaction-chip"][data-emoji="${emoji}"]`);
}

/** Starts a thread from a message and waits until the new thread is open; returns its room ID. */
export async function startThread(page: Page, message: Locator): Promise<string> {
	await (await messageAction(message, 'Start thread')).click();
	await expect(page.getByRole('button', { name: 'Back to room', exact: true })).toBeVisible();
	// The row is in the sidebar, which is a page of its own on phones: attached, not necessarily visible.
	const selected = page.locator('[data-testid="thread-list"] button[data-thread][aria-current="page"]');
	await expect(selected).toHaveCount(1);
	const threadId = await selected.getAttribute('data-thread');
	expect(threadId).toBeTruthy();
	return threadId!;
}
