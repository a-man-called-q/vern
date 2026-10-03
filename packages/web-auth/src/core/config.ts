import { env } from "node:process";

// The settings the server reads from its environment, checked where they are
// read: a missing or malformed one fails the request that needs it, with a
// message that names it. Tokens travel over these URLs, so production refuses
// plain HTTP for every one of them.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isProduction() {
	return env.NODE_ENV === "production";
}

/**
 * The URL in the setting `name`: http(s), without credentials, a query, or a
 * fragment. An `origin` has no path either. `requireHttps` refuses http.
 */
export function parseHttpUrl(
	name: string,
	value: string,
	options: { kind: "origin" | "URL" | "issuer URL"; requireHttps: boolean },
) {
	const url = new URL(value);

	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		(options.kind === "origin" && url.pathname !== "/") ||
		url.search ||
		url.hash
	) {
		throw new Error(
			options.kind === "origin"
				? `${name} must be an http(s) origin without a path`
				: `${name} must be a valid http(s) ${options.kind}`,
		);
	}

	if (options.requireHttps && url.protocol !== "https:") {
		throw new Error(`${name} must use HTTPS in production`);
	}

	return url;
}

function required(name: string) {
	const value = env[name];

	if (!value) {
		throw new Error(`${name} is required`);
	}

	return value;
}

function getAppBaseUrl() {
	return parseHttpUrl("APP_URL", required("APP_URL"), {
		kind: "origin",
		requireHttps: isProduction(),
	});
}

export function getAppUrl(path: string) {
	return new URL(path, getAppBaseUrl());
}

export function getAppOrigin() {
	return getAppBaseUrl().origin;
}

export function getIssuerUrl() {
	const url = parseHttpUrl("ZITADEL_ISSUER", required("ZITADEL_ISSUER"), {
		kind: "issuer URL",
		requireHttps: isProduction(),
	});

	if (
		url.protocol === "http:" &&
		!(env.NODE_ENV === "development" && LOOPBACK_HOSTS.has(url.hostname))
	) {
		throw new Error(
			"ZITADEL_ISSUER must use HTTPS except for loopback HTTP in development",
		);
	}

	return url;
}

export function getClientId() {
	return required("ZITADEL_CLIENT_ID");
}

/**
 * Puts the user's own organization in the access token, which the Axum template
 * reads as `org_id`. The organization in the role claim is the one that owns the
 * grant, not the user's, so it is not used for that.
 */
export const RESOURCE_OWNER_SCOPE = "urn:zitadel:iam:user:resourceowner";

export function getProjectAudienceScope() {
	const projectId = env.ZITADEL_PROJECT_ID;

	if (!projectId || !/^[A-Za-z0-9_-]+$/.test(projectId)) {
		throw new Error("ZITADEL_PROJECT_ID must be a valid ZITADEL project ID");
	}

	return `urn:zitadel:iam:org:project:id:${projectId}:aud`;
}

/** Seals the sign-in transaction cookie. */
export function getSessionSecret() {
	const secret = env.SESSION_SECRET;

	if (!secret || secret.length < 32) {
		throw new Error("SESSION_SECRET must contain at least 32 characters");
	}

	return secret;
}
