import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	reporter: "line",
	timeout: 90_000,
	use: {
		// The local environment serves certificates from a local authority.
		ignoreHTTPSErrors: true,
		headless: true,
		screenshot: "only-on-failure",
	},
});
