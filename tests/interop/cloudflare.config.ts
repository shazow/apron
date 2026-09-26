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
			// Browser ceremonies share one loopback IP. Keep posting limits real,
			// but allow enough handshakes, frames, auth attempts, and registrations
			// (guests only read, so writers sign in with a passkey) for the suite.
			command: `npx wrangler dev --ip 127.0.0.1 --port 8788 --persist-to ${quote(state)} --var RP_ORIGINS:http://localhost:8788 --var 'ALLOWED_ORIGINS:*' --var LIMIT_CONNECTION_ADMISSIONS_PER_IP_MINUTE:30 --var LIMIT_AUTH_ATTEMPTS_PER_IP_MINUTE:60 --var LIMIT_REGISTRATIONS_PER_IP_DAY:10 --var LIMIT_FRAMES_PER_IP_MINUTE:240`,
			cwd: path.join(root, 'servers/cloudflare-worker'),
			port: 8788,
			timeout: 120_000,
			reuseExistingServer: false
		}
	]
});
