import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(configDirectory, '../..');
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

/**
 * Rendering benchmarks against the production build, served by the Go server
 * on its own port. Build the web client first (`make build-web`).
 */
export default defineConfig({
	testDir: configDirectory,
	testMatch: /perf\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	timeout: 180_000,
	reporter: 'list',
	use: {
		...devices['Desktop Chrome'],
		baseURL: 'http://127.0.0.1:8090',
		...(chromiumExecutablePath ? { launchOptions: { executablePath: chromiumExecutablePath } } : {})
	},
	webServer: {
		command: `go run ./cmd/aprond --addr 127.0.0.1:8090 --allow-any-origin --static-dir ${path.join(repositoryRoot, 'clients/web/build')}`,
		cwd: path.join(repositoryRoot, 'servers/go'),
		url: 'http://127.0.0.1:8090/healthz',
		timeout: 120_000,
		reuseExistingServer: false
	}
});
