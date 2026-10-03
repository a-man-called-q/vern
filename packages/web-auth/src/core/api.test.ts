import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiClientFactory, createAuthenticatedApiFetcher } from "./api";
import { AuthenticationRequiredError } from "./auth-error";

/** Bun's types give `fetch` a `preconnect` member, so a bare function is not assignable. */
function fakeFetch(
	handler: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return Object.assign(handler, { preconnect: () => undefined });
}

for (let webApp = 1; webApp <= 4; webApp += 1) {
	for (let api = 1; api <= 3; api += 1) {
		test(`web app ${webApp} sends its bearer token to API ${api}`, async () => {
			const token = `web-app-${webApp}-access-token`;
			const expectedSubject = `user-${webApp}`;
			const fetchApi = createAuthenticatedApiFetcher({
				baseUrl: `http://axum-${api}.test`,
				getAccessToken: async () => token,
				fetcher: fakeFetch(async (input, init) => {
					assert.equal(String(input), `http://axum-${api}.test/api/me`);
					const headers = new Headers(init?.headers);
					assert.equal(headers.get("authorization"), `Bearer ${token}`);
					assert.equal(headers.has("cookie"), false);
					assert.equal(init?.credentials, "omit");
					return Response.json({ sub: expectedSubject });
				}),
			});

			const response = await fetchApi("/api/me", {
				headers: { Cookie: "app-session=browser-cookie" },
			});
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { sub: expectedSubject });
		});
	}
}

test("refuses caller-controlled API URLs", async () => {
	const fetchApi = createAuthenticatedApiFetcher({
		baseUrl: "http://axum.test",
		getAccessToken: async () => "opaque-token",
		fetcher: fakeFetch(async () => new Response(null, { status: 200 })),
	});
	await assert.rejects(fetchApi("//attacker.test/api/me"));
	await assert.rejects(fetchApi("https://attacker.test/api/me"));
});

function apiAnswering(status: number, onUnauthorized?: () => Promise<boolean>) {
	return createAuthenticatedApiFetcher({
		baseUrl: "http://axum.test",
		getAccessToken: async () => "opaque-token",
		fetcher: fakeFetch(async () => new Response(null, { status })),
		onUnauthorized,
	});
}

test("asks to sign in again when the API refuses the token", async () => {
	let sessionsDropped = 0;
	const fetchApi = apiAnswering(401, async () => {
		sessionsDropped += 1;
		return true;
	});
	await assert.rejects(fetchApi("/api/me"), AuthenticationRequiredError);
	assert.equal(sessionsDropped, 1);
});

test("returns the 401 when the session was kept", async () => {
	const response = await apiAnswering(401, async () => false)("/api/me");
	assert.equal(response.status, 401);
});

test("returns the 401 when nothing handles it", async () => {
	const response = await apiAnswering(401)("/api/me");
	assert.equal(response.status, 401);
});

test("leaves other statuses to the caller", async () => {
	for (const status of [200, 403, 500]) {
		const response = await apiAnswering(status, async () => {
			throw new Error("only a 401 may drop the session");
		})("/api/me");
		assert.equal(response.status, status);
	}
});

const createApiClient = createApiClientFactory({
	getAccessToken: async () => "opaque-token",
});

test("an API client reads the URL from its own variable and refuses a missing one", async () => {
	delete process.env.BILLING_API_URL;
	const fetchBillingApi = createApiClient("BILLING_API_URL");
	await assert.rejects(
		fetchBillingApi("/api/me"),
		/BILLING_API_URL is required/,
	);
});

test("an API client needs an upper-case variable name", () => {
	assert.throws(
		() => createApiClient("billing url"),
		/upper-case variable name/,
	);
	assert.throws(
		() => createApiClient("billing_api_url"),
		/upper-case variable name/,
	);
});
