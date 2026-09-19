import { expect, test } from '@playwright/test';
import { composer, openChat } from './test-helpers';

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
