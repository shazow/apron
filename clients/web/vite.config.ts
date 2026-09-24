import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

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
