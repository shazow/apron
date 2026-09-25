import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	],
	test: {
		projects: [
			{ extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'], exclude: ['src/**/*.svelte.test.ts'] } },
			// Rune tests need Svelte's client compile and runtime, where effects run.
			{ extends: true, resolve: { conditions: ['browser'] }, test: { name: 'runes', include: ['src/**/*.svelte.test.ts'], environment: './src/lib/test/runes-environment.ts' } }
		]
	},
	server: {
		proxy: {
			'/ws': {
				target: 'ws://127.0.0.1:8080',
				ws: true
			},
			// Upload, file, and stream URLs the Go server mints from this host.
			'/write/': 'http://127.0.0.1:8080',
			'/files/': 'http://127.0.0.1:8080',
			'/streams/': 'http://127.0.0.1:8080'
		}
	}
});
