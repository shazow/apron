import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.toml" },
			miniflare: { bindings: { IP_HMAC_SECRET: "local-unit-test-secret-at-least-32-bytes" } },
		}),
	],
	test: {
		globals: true,
		include: ["test/**/*.test.ts"],
	},
});
