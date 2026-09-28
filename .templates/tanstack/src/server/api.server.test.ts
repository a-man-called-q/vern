import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthenticatedApiFetcher } from "./api.server";

for (let webApp = 1; webApp <= 4; webApp += 1) {
	for (let api = 1; api <= 3; api += 1) {
		test(`web app ${webApp} sends its bearer token to API ${api}`, async () => {
			const token = `web-app-${webApp}-access-token`;
			const expectedSubject = `user-${webApp}`;
			const fetchApi = createAuthenticatedApiFetcher({
				baseUrl: `http://axum-${api}.test`,
				getAccessToken: async () => token,
				fetcher: async (input, init) => {
					assert.equal(String(input), `http://axum-${api}.test/api/me`);
					const headers = new Headers(init?.headers);
					assert.equal(headers.get("authorization"), `Bearer ${token}`);
					assert.equal(headers.has("cookie"), false);
					assert.equal(init?.credentials, "omit");
					return Response.json({ sub: expectedSubject });
				},
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
		fetcher: async () => new Response(null, { status: 200 }),
	});
	await assert.rejects(fetchApi("//attacker.test/api/me"));
	await assert.rejects(fetchApi("https://attacker.test/api/me"));
});
