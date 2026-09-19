import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: path.dirname(fileURLToPath(import.meta.url)),
	testMatch: /wire\.spec\.ts$/,
	outputDir: 'test-results/wire',
	workers: 1,
	fullyParallel: false,
	timeout: 15_000,
	expect: { timeout: 3_000 },
	reporter: 'list'
});
