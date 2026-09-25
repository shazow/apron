import type { Environment } from 'vitest/runtime';

/**
 * Node with Svelte's client compile and runtime, so rune modules under test
 * run their effects as they do in the browser. `vite.config.ts` runs every
 * `*.svelte.test.ts` file in it.
 */
export default {
	name: 'runes',
	viteEnvironment: 'client',
	setup: () => ({ teardown() {} })
} satisfies Environment;
