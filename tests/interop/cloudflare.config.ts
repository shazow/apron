import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const scratch = path.join(root, '.devenv', 'cloudflare-browser');
mkdirSync(scratch, { recursive: true });
const state = mkdtempSync(path.join(scratch, 'worker-'));
process.once('exit', () => rmSync(state, { recursive: true, force: true }));
const browser = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export default defineConfig({
	testDir: directory,
	testMatch: 'cloudflare.spec.ts',
	workers: 1,
	timeout: 60_000,
	use: {
		...devices['Desktop Chrome'],
		baseURL: 'http://localhost:8788',
		trace: 'retain-on-failure',
		...(browser ? { launchOptions: { executablePath: browser } } : {})
	},
	webServer: [
		{
			command: `npx wrangler dev --ip 127.0.0.1 --port 8788 --persist-to ${quote(state)} --var IP_HMAC_SECRET:local-browser-test-secret-at-least-32-bytes --var RP_ORIGINS:http://localhost:8788 --var ALLOWED_ORIGINS:http://localhost:8788`,
			cwd: path.join(root, 'servers/cloudflare-worker'),
			port: 8788,
			timeout: 120_000,
			reuseExistingServer: false
		}
	]
});
