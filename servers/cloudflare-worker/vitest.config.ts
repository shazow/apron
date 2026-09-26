import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.toml" },
			// Most suites use guests as convenient posters; test/read-only-guests
			// turns this off to cover the deployed default, where guests only read.
			miniflare: { bindings: { GUEST_POSTING: "true" } },
		}),
	],
	test: {
		globals: true,
		include: ["test/**/*.test.ts"],
	},
});
