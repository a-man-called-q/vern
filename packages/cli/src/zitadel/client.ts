type Fetcher = typeof fetch;

export type ApiOptions = {
	issuer: string;
	token: string;
	orgId?: string;
	fetcher?: Fetcher;
};

export class ZitadelApiError extends Error {
	constructor(
		method: string,
		path: string,
		readonly status: number,
		readonly detail: string,
	) {
		super(`ZITADEL ${method} ${path} failed: HTTP ${status} ${detail}`.trim());
		this.name = "ZitadelApiError";
	}
}

function errorDetail(payload: unknown): string {
	if (payload && typeof payload === "object") {
		const message = (payload as Record<string, unknown>).message;
		if (typeof message === "string") return message.slice(0, 300);
	}
	return "";
}

export async function callApi(
	options: ApiOptions,
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
	path: string,
	body?: unknown,
): Promise<Record<string, unknown>> {
	const fetcher = options.fetcher ?? fetch;
	const response = await fetcher(new URL(path, new URL(options.issuer).origin), {
		method,
		redirect: "error",
		headers: {
			Authorization: `Bearer ${options.token}`,
			"Content-Type": "application/json",
			Accept: "application/json",
			...(options.orgId ? { "x-zitadel-orgid": options.orgId } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	const text = await response.text();
	let payload: unknown = {};
	try {
		payload = text ? JSON.parse(text) : {};
	} catch {
		// A non-JSON error body still fails below with just the status code.
	}
	if (!response.ok) {
		throw new ZitadelApiError(method, path, response.status, errorDetail(payload));
	}
	return payload as Record<string, unknown>;
}

/** ZITADEL answers 404, or 400 for an ID it cannot parse, when there is no such thing. */
export function isNotFound(error: unknown): boolean {
	return error instanceof ZitadelApiError && (error.status === 404 || error.status === 400);
}

/**
 * ZITADEL refuses an update that changes nothing. Each resource has its own
 * error ID for that (`ids`); some only say it in words.
 */
export function isNoChanges(error: unknown, ...ids: string[]): boolean {
	if (!(error instanceof ZitadelApiError)) return false;
	return ids.some((id) => error.detail.includes(id)) || /no changes|not been changed/i.test(error.detail);
}

/** An ID that goes into a request path: anything else could change the request. */
export function assertProjectId(projectId: string): void {
	if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
		throw new Error("ZITADEL project ID must contain only letters, digits, - and _");
	}
}

/**
 * The one result of a search whose name is exactly `name`: ZITADEL's equality
 * query can match more loosely than that. Two are a mistake to stop on.
 */
export function onlyNamed<T>(items: T[] | undefined, name: string, nameOf: (item: T) => string, what: string): T | undefined {
	const found = (items ?? []).filter((item) => nameOf(item) === name);
	if (found.length > 1) throw new Error(`More than one ${what} is named "${name}"`);
	return found[0];
}
