import { readFileSync } from "node:fs";
import { type ApiOptions, callApi, isNotFound, onlyNamed } from "./client";

/** Whether ZITADEL still has the key in this file, e.g. after a database reset. */
export async function keyIsKnown(api: ApiOptions, projectId: string, keyFile: string): Promise<boolean> {
	let key: { appId?: string; keyId?: string };
	try {
		key = JSON.parse(readFileSync(keyFile, "utf8"));
	} catch {
		return false;
	}
	if (!key.appId || !key.keyId) return false;
	try {
		await callApi(api, "GET", `/management/v1/projects/${projectId}/apps/${key.appId}/keys/${key.keyId}`);
		return true;
	} catch (error) {
		if (isNotFound(error)) return false;
		throw error;
	}
}

/** Creates the API application if needed and a new JSON key for it. */
export async function createApiKey(api: ApiOptions, projectId: string, name: string): Promise<string> {
	const base = `/management/v1/projects/${projectId}/apps`;
	const search = await callApi(api, "POST", `${base}/_search`, {
		queries: [{ nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS" } }],
	});
	const found = onlyNamed(
		search.result as { id: string; name: string; apiConfig?: unknown }[] | undefined,
		name,
		(app) => app.name,
		"application",
	);
	if (found && !found.apiConfig) {
		throw new Error(`An application named "${name}" exists but is not an API application`);
	}
	let appId = found?.id;
	if (!appId) {
		const created = await callApi(api, "POST", `${base}/api`, {
			name,
			authMethodType: "API_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT",
		});
		appId = String(created.appId);
	}
	const key = await callApi(api, "POST", `${base}/${appId}/keys`, { type: "KEY_TYPE_JSON" });
	return Buffer.from(String(key.keyDetails), "base64").toString("utf8");
}
