import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	reporter: "line",
	timeout: 90_000,
	use: {
		// deploy/docker-compose.local.yml serves certificates from a local authority.
		ignoreHTTPSErrors: true,
		headless: true,
		screenshot: "only-on-failure",
	},
});
