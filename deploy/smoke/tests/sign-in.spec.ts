import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const env = (name: string) => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
};

test("signs in to the web app and reaches the API", async ({ page }) => {
	await page.goto(`https://${env("APP_DOMAIN")}/`);
	await page.getByRole("link", { name: "Log in" }).click();

	await page.waitForURL(new RegExp(`${env("AUTH_DOMAIN")}/ui/v2/login/loginname`));
	await expect(page.locator(".vern-auth-panel")).toBeVisible();
	await page.getByTestId("username-text-input").fill(env("LOGIN_NAME"));
	await page.getByTestId("submit-button").click();

	await page.getByTestId("password-text-input").fill(env("PASSWORD"));
	await page.getByTestId("submit-button").click();

	// ZITADEL asks the generated admin for a new password on the first sign-in.
	await page.waitForURL(new RegExp(`password/change|${env("APP_DOMAIN")}/dashboard`));
	if (page.url().includes("password/change")) {
		const current = page.getByTestId("password-change-current-text-input");
		if (await current.count()) await current.fill(env("PASSWORD"));
		await page.getByTestId("password-change-text-input").fill(env("NEW_PASSWORD"));
		await page.getByTestId("password-change-confirm-text-input").fill(env("NEW_PASSWORD"));
		await page.getByTestId("submit-button").click();
		// Tells the smoke-test.sh that runs this to record the new password.
		writeFileSync("/out/password-changed", "");
	}

	await page.waitForURL(`https://${env("APP_DOMAIN")}/dashboard`, { timeout: 30_000 });
	await expect(page.getByText("API connection")).toBeVisible();
	await expect(page.getByText("Connected", { exact: true })).toBeVisible();
});
