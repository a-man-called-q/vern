import { env } from "node:process";
import { AuthenticationRequiredError } from "./auth-error";
import { isProduction, parseHttpUrl } from "./config.server";

function parseApiBaseUrl(value: string, requireHttps: boolean) {
	const url = parseHttpUrl("API_BASE_URL", value, {
		kind: "URL",
		requireHttps,
	});
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
		options.requireHttps ?? isProduction(),
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
 * Server-only BFF helper for the API whose base URL is in the environment
 * variable `envKey`. An app that calls a second API makes one client per API, in
 * the server module of that API: `const fetchBillingApi =
 * createApiClient("BILLING_API_URL")`. List the APIs in `API_APPS` in the app's
 * `.env.example` and `bun run setup` fills the variables in.
 *
 * `path` must be a relative path, never a caller URL. The call throws
 * `AuthenticationRequiredError` when the API refuses the user's token (revoked
 * upstream) and the app session was dropped: send the user to sign in.
 */
export function createApiClient(envKey: string) {
	if (!/^[A-Z][A-Z0-9_]*$/.test(envKey)) {
		throw new Error("envKey must be an upper-case variable name");
	}
	return async (path: string, init: RequestInit = {}): Promise<Response> => {
		const baseUrl = env[envKey];
		if (!baseUrl) throw new Error(`${envKey} is required`);
		const { dropRevokedSession, getApiAccessToken } = await import(
			"./auth-flow.server"
		);
		return createAuthenticatedApiFetcher({
			baseUrl,
			getAccessToken: getApiAccessToken,
			onUnauthorized: dropRevokedSession,
		})(path, init);
	};
}

/** The API in `API_BASE_URL`: the one `bun run setup` wires a web app to. */
export const fetchAuthenticatedApi = createApiClient("API_BASE_URL");
