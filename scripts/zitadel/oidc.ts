import { type ApiOptions, assertProjectId, callApi, isNoChanges, onlyNamed } from "./client";

export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// ZITADEL rejects an update that changes nothing with this error id.
const NO_CHANGES_ID = "COMMAND-1m88i";

export type OidcAppConfig = ReturnType<typeof buildOidcConfig>;

export type ProvisionResult = {
	action: "created" | "updated" | "unchanged";
	appId: string;
	clientId: string;
};

/**
 * The application settings the Vern app templates depend on: Authorization
 * Code with PKCE (no client secret), refresh tokens, and the two callback URLs.
 * Development Mode is what lets ZITADEL accept `http://` redirect URIs, so it
 * follows the app URL and can only be on for localhost.
 */
export function buildOidcConfig(options: {
	appUrl: string;
	profileInIdToken?: boolean;
}) {
	const url = new URL(options.appUrl);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error("APP_URL must be an http(s) origin without a path");
	}
	if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
		throw new Error("APP_URL must use HTTPS unless it points at localhost");
	}

	return {
		redirectUris: [`${url.origin}/auth/callback`],
		postLogoutRedirectUris: [`${url.origin}/auth/logout/callback`],
		responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
		grantTypes: [
			"OIDC_GRANT_TYPE_AUTHORIZATION_CODE",
			"OIDC_GRANT_TYPE_REFRESH_TOKEN",
		],
		appType: "OIDC_APP_TYPE_WEB",
		authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
		devMode: url.protocol === "http:",
		accessTokenType: "OIDC_TOKEN_TYPE_BEARER",
		accessTokenRoleAssertion: false,
		idTokenRoleAssertion: false,
		idTokenUserinfoAssertion: options.profileInIdToken ?? false,
		clockSkew: "0s",
		additionalOrigins: [] as string[],
	};
}

/**
 * Creates the application, or brings an existing one of the same name back to
 * the configuration above. Safe to run repeatedly.
 */
export async function provisionApplication(
	options: ApiOptions & {
		projectId: string;
		name: string;
		config: OidcAppConfig;
	},
): Promise<ProvisionResult> {
	assertProjectId(options.projectId);
	if (options.name.length < 1 || options.name.length > 200) {
		throw new Error("Application name must be 1-200 characters");
	}

	const base = `/management/v1/projects/${options.projectId}/apps`;
	const search = await callApi(options, "POST", `${base}/_search`, {
		queries: [
			{
				nameQuery: { name: options.name, method: "TEXT_QUERY_METHOD_EQUALS" },
			},
		],
	});
	const existing = onlyNamed(
		search.result as { id: string; name: string; oidcConfig?: { clientId?: string } }[] | undefined,
		options.name,
		(app) => app.name,
		"application",
	);

	if (!existing) {
		const created = await callApi(options, "POST", `${base}/oidc`, {
			name: options.name,
			version: "OIDC_VERSION_1_0",
			...options.config,
		});
		return {
			action: "created",
			appId: String(created.appId),
			clientId: String(created.clientId),
		};
	}

	if (!existing.oidcConfig?.clientId) {
		throw new Error(
			`An application named "${options.name}" exists but is not an OIDC application`,
		);
	}

	try {
		await callApi(options, "PUT", `${base}/${existing.id}/oidc_config`, options.config);
	} catch (error) {
		if (isNoChanges(error, NO_CHANGES_ID)) {
			return {
				action: "unchanged",
				appId: existing.id,
				clientId: existing.oidcConfig.clientId,
			};
		}
		throw error;
	}
	return {
		action: "updated",
		appId: existing.id,
		clientId: existing.oidcConfig.clientId,
	};
}
