import { type ApiOptions, callApi, isNotFound, onlyNamed } from "./client";

async function findOrCreateProject(api: ApiOptions, name: string): Promise<{ id: string; created: boolean }> {
	const search = await callApi(api, "POST", "/management/v1/projects/_search", {
		queries: [{ nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS" } }],
	});
	const found = onlyNamed(
		search.result as { id: string; name: string }[] | undefined,
		name,
		(project) => project.name,
		"ZITADEL project",
	);
	if (found) return { id: found.id, created: false };
	const created = await callApi(api, "POST", "/management/v1/projects", { name });
	return { id: String(created.id), created: true };
}

async function projectExists(api: ApiOptions, id: string): Promise<boolean> {
	try {
		await callApi(api, "GET", `/management/v1/projects/${encodeURIComponent(id)}`);
		return true;
	} catch (error) {
		if (isNotFound(error)) return false;
		throw error;
	}
}

/**
 * Keeps the project `current` names while ZITADEL still has it, or finds or
 * creates the project by name. `action` says which, so the caller can store a
 * new ID.
 */
export async function ensureProject(
	api: ApiOptions,
	current: string | undefined,
	name: string,
): Promise<{ id: string; action: "kept" | "found" | "created" }> {
	if (current && (await projectExists(api, current))) return { id: current, action: "kept" };
	const project = await findOrCreateProject(api, name);
	return { id: project.id, action: project.created ? "created" : "found" };
}
