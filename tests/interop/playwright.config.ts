import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(configDirectory, '../..');
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
// TODO: Make server ports configurable so browser tests can run beside local development servers.

export default defineConfig({
	testDir: configDirectory,
	testMatch: /\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	timeout: 30_000,
	expect: {
		timeout: 10_000
	},
	reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
	use: {
		baseURL: 'http://127.0.0.1:5173',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'desktop',
			testMatch: /(chat|webauthn|reference)\.spec\.ts$/,
			use: {
				...devices['Desktop Chrome'],
				...(chromiumExecutablePath
					? { launchOptions: { executablePath: chromiumExecutablePath } }
					: {})
			}
		},
		{
			name: 'mobile',
			testMatch: /responsive\.spec\.ts$/,
			use: {
				...devices['Pixel 5'],
				...(chromiumExecutablePath
					? { launchOptions: { executablePath: chromiumExecutablePath } }
					: {})
			}
		}
	],
	webServer: [
		{
			command: 'go run ./cmd/aprond --store memory --addr 127.0.0.1:8080',
			cwd: path.join(repositoryRoot, 'servers/go'),
			url: 'http://127.0.0.1:8080/healthz',
			timeout: 120_000,
			reuseExistingServer: false
		},
		{
			command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
			cwd: path.join(repositoryRoot, 'clients/web'),
			url: 'http://127.0.0.1:5173',
			timeout: 120_000,
			reuseExistingServer: false
		}
	]
});
