import type { App } from "../lib/projects";

/** The variable that holds the URL of an Axum app: `inventory` becomes `INVENTORY_API_URL`. */
export function apiUrlKey(name: string): string {
	const key = `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_URL`;
	if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`"${name}" cannot be made into a variable name`);
	return key;
}

function notAnApi(app: App, what: string, names: string[]): Error {
	return new Error(
		`${app.path}: ${what} an Axum API with a PORT under services/` + (names.length > 0 ? ` (found: ${names.join(", ")})` : ""),
	);
}

/**
 * The API a web app talks to. `API_BASE_URL` set by hand wins; then the Axum app
 * named by `API_APP`; with no name, the workspace's only API. Several APIs and no
 * name leave it empty, and say so instead of leaving the app quietly unwired.
 */
export function chooseApiUrl(
	app: App,
	appEnv: Map<string, string>,
	apiUrls: Map<string, string>,
): { url?: string; message?: string } {
	if (appEnv.get("API_BASE_URL")) return {};
	const names = [...apiUrls.keys()].sort();
	const wanted = appEnv.get("API_APP");
	if (wanted) {
		const url = apiUrls.get(wanted);
		if (url) return { url };
		throw notAnApi(app, `API_APP=${wanted} does not name`, names);
	}
	if (names.length === 1) return { url: apiUrls.get(names[0]) };
	// An app that lists its APIs in API_APPS reaches them by their own variables.
	if (names.length > 1 && !appEnv.get("API_APPS")) {
		return {
			message: `${app.path}: API_BASE_URL is not set (${names.length} APIs found: ${names.join(", ")}). Set API_APP=<api> in ${app.path}/.env and run this again.`,
		};
	}
	return {};
}

/**
 * The APIs a web app calls besides `API_BASE_URL`: `API_APPS=inventory,media`
 * lists Axum apps, and each gets a variable with its URL (`INVENTORY_API_URL`)
 * unless the app already set one.
 */
export function chooseNamedApiUrls(
	app: App,
	appEnv: Map<string, string>,
	apiUrls: Map<string, string>,
): [key: string, url: string][] {
	const wanted = (appEnv.get("API_APPS") ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	const names = [...apiUrls.keys()].sort();
	return wanted.flatMap((name) => {
		const url = apiUrls.get(name);
		if (!url) throw notAnApi(app, `API_APPS names ${name}, which is not`, names);
		const key = apiUrlKey(name);
		return appEnv.get(key) ? [] : [[key, url] as [string, string]];
	});
}
