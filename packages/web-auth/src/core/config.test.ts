import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getIssuerUrl, parseHttpUrl } from "./config";

const saved = { ...process.env };
afterEach(() => {
	for (const key of ["NODE_ENV", "ZITADEL_ISSUER"]) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

function setEnv(values: Record<string, string>) {
	Object.assign(process.env, values);
}

test("an origin takes no path, a URL may", () => {
	const options = { requireHttps: false };
	assert.equal(
		parseHttpUrl("APP_URL", "http://localhost:3000", {
			kind: "origin",
			...options,
		}).origin,
		"http://localhost:3000",
	);
	assert.throws(
		() =>
			parseHttpUrl("APP_URL", "http://localhost:3000/app", {
				kind: "origin",
				...options,
			}),
		/APP_URL must be an http\(s\) origin without a path/,
	);
	assert.equal(
		parseHttpUrl("API_BASE_URL", "http://api.test/v1", {
			kind: "URL",
			...options,
		}).pathname,
		"/v1",
	);
});

test("credentials, a query, a fragment, and other schemes are refused", () => {
	for (const value of [
		"http://user:secret@api.test",
		"http://api.test/?debug=1",
		"http://api.test/#top",
		"ftp://api.test",
	]) {
		assert.throws(
			() =>
				parseHttpUrl("API_BASE_URL", value, {
					kind: "URL",
					requireHttps: false,
				}),
			/API_BASE_URL must be a valid http\(s\) URL/,
			value,
		);
	}
});

test("HTTPS is required when asked", () => {
	assert.throws(
		() =>
			parseHttpUrl("API_BASE_URL", "http://api.test", {
				kind: "URL",
				requireHttps: true,
			}),
		/API_BASE_URL must use HTTPS in production/,
	);
});

test("the issuer may be plain HTTP only on this machine in development", () => {
	setEnv({ NODE_ENV: "development", ZITADEL_ISSUER: "http://localhost:8081" });
	assert.equal(getIssuerUrl().host, "localhost:8081");

	setEnv({ ZITADEL_ISSUER: "http://auth.example.com" });
	assert.throws(() => getIssuerUrl(), /HTTPS except for loopback HTTP/);

	setEnv({ NODE_ENV: "production", ZITADEL_ISSUER: "http://localhost:8081" });
	assert.throws(
		() => getIssuerUrl(),
		/ZITADEL_ISSUER must use HTTPS in production/,
	);

	setEnv({ ZITADEL_ISSUER: "https://auth.example.com" });
	assert.equal(getIssuerUrl().protocol, "https:");
});
