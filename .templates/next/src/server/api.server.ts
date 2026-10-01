import { env } from "node:process";
import { AuthenticationRequiredError } from "./auth-error";

function parseApiBaseUrl(value: string, requireHttps: boolean) {
	const url = new URL(value);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error("API_BASE_URL must be a valid http(s) URL");
	}
	if (requireHttps && url.protocol !== "https:") {
		throw new Error("API_BASE_URL must use HTTPS in production");
	}

	url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
	return url;
}

export function createAuthenticatedApiFetcher(options: {
	baseUrl: string;
	getAccessToken: () => Promise<string>;
	fetcher?: typeof fetch;
	requireHttps?: boolean;
	/**
	 * Called when the API answers 401. Return true when the session is gone and
	 * the user must sign in again; the call then throws `AuthenticationRequiredError`.
	 * Without it, or when it returns false, the 401 reaches the caller.
	 */
	onUnauthorized?: () => Promise<boolean>;
}) {
	const baseUrl = parseApiBaseUrl(
		options.baseUrl,
		options.requireHttps ?? env.NODE_ENV === "production",
	);
	const fetcher = options.fetcher ?? fetch;

	return async (path: string, init: RequestInit = {}): Promise<Response> => {
		if (!path.startsWith("/") || path.startsWith("//")) {
			throw new Error("API path must begin with a single slash");
		}

		const targetUrl = new URL(path.slice(1), baseUrl);
		if (targetUrl.origin !== baseUrl.origin) {
			throw new Error("API path must stay on the configured API origin");
		}

		const accessToken = await options.getAccessToken();
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${accessToken}`);
		headers.delete("Cookie");

		const response = await fetcher(targetUrl, {
			...init,
			headers,
			cache: "no-store",
			credentials: "omit",
			redirect: "manual",
		});
		if (response.status === 401 && (await options.onUnauthorized?.())) {
			throw new AuthenticationRequiredError();
		}
		return response;
	};
}

/**
 * Server-only BFF helper. `path` must be a relative path, never a caller URL.
 * Throws `AuthenticationRequiredError` when the API refuses the user's token
 * (revoked upstream) and the app session was dropped: send the user to sign in.
 */
export async function fetchAuthenticatedApi(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const baseUrl = env.API_BASE_URL;
	if (!baseUrl) throw new Error("API_BASE_URL is required");
	const { dropRevokedSession, getApiAccessToken } = await import(
		"./auth.server"
	);
	return createAuthenticatedApiFetcher({
		baseUrl,
		getAccessToken: getApiAccessToken,
		onUnauthorized: dropRevokedSession,
	})(path, init);
}
