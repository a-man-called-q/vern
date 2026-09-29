import "server-only";
import { env } from "node:process";
import * as oidc from "openid-client";
import { createTtlCache } from "./ttl-cache";

const LOCAL_ISSUER_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const DISCOVERY_TTL_MS = 60 * 60 * 1000;

// Deliberately per module, not on globalThis: Next.js bundles openid-client once
// per route, and a Configuration only works with the copy that created it.
const discoveryCache: {
	current?: { key: string; get: () => Promise<oidc.Configuration> };
} = {};

function getAppBaseUrl() {
	const value = env.APP_URL;

	if (!value) {
		throw new Error("APP_URL is required");
	}

	const url = new URL(value);

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

	if (env.NODE_ENV === "production" && url.protocol !== "https:") {
		throw new Error("APP_URL must use HTTPS in production");
	}

	return url;
}

export function getAppUrl(path: string) {
	return new URL(path, getAppBaseUrl());
}

export function getAppOrigin() {
	return getAppBaseUrl().origin;
}

export function getProjectAudienceScope() {
	const projectId = env.ZITADEL_PROJECT_ID;

	if (!projectId || !/^[A-Za-z0-9_-]+$/.test(projectId)) {
		throw new Error("ZITADEL_PROJECT_ID must be a valid ZITADEL project ID");
	}

	return `urn:zitadel:iam:org:project:id:${projectId}:aud`;
}

function getIssuerUrl() {
	const value = env.ZITADEL_ISSUER;

	if (!value) {
		throw new Error("ZITADEL_ISSUER is required");
	}

	const url = new URL(value);

	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error("ZITADEL_ISSUER must be a valid http(s) issuer URL");
	}

	if (env.NODE_ENV === "production" && url.protocol !== "https:") {
		throw new Error("ZITADEL_ISSUER must use HTTPS in production");
	}

	if (
		url.protocol === "http:" &&
		!(env.NODE_ENV === "development" && LOCAL_ISSUER_HOSTS.has(url.hostname))
	) {
		throw new Error(
			"ZITADEL_ISSUER must use HTTPS except for loopback HTTP in development",
		);
	}

	return url;
}

export async function getOidcConfiguration() {
	const clientId = env.ZITADEL_CLIENT_ID;

	if (!clientId) {
		throw new Error("ZITADEL_CLIENT_ID is required");
	}

	const redirectUri = getAppUrl("/auth/callback").href;
	const issuer = getIssuerUrl();

	// Discovery is a network round trip, so reuse it. Keying on the settings it
	// was built from keeps a dev-server `.env` edit from serving a stale client.
	const key = [issuer.href, clientId, redirectUri].join(" ");
	if (discoveryCache.current?.key !== key) {
		discoveryCache.current = {
			key,
			get: createTtlCache(
				() =>
					oidc.discovery(
						issuer,
						clientId,
						{ redirect_uris: [redirectUri] },
						oidc.None(),
						{
							...(issuer.protocol === "http:"
								? { execute: [oidc.allowInsecureRequests] }
								: {}),
						},
					),
				DISCOVERY_TTL_MS,
			),
		};
	}

	return discoveryCache.current.get();
}
