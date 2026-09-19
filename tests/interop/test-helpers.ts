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
	await expect(message, `deleted message did not appear for event ${eventId}`).toBeVisible();
	await expect(message.getByText('Message deleted', { exact: true })).toBeVisible();
	return message;
}

export async function editMessage(message: Locator, text: string): Promise<void> {
	await message.getByRole('button', { name: 'Edit message', exact: true }).click();
	const editor = message.getByRole('textbox', { name: 'Edit message', exact: true });
	await expect(editor).toBeVisible();
	await editor.fill(text);
	await message.getByRole('button', { name: 'Save changes', exact: true }).click();
}

export async function deleteMessage(page: Page, message: Locator): Promise<void> {
	page.once('dialog', (dialog) => dialog.accept());
	await message.getByRole('button', { name: 'Delete message', exact: true }).click();
}
