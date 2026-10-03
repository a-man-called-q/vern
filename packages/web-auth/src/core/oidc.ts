import * as oidc from "openid-client";
import { getAppUrl, getClientId, getIssuerUrl } from "./config";
import { createTtlCache } from "./ttl-cache";

const DISCOVERY_TTL_MS = 60 * 60 * 1000;

// Deliberately per module, not on globalThis: a bundler may include
// openid-client more than once (Next.js does, once per route), and a
// Configuration only works with the copy that created it.
const discoveryCache: {
	current?: { key: string; get: () => Promise<oidc.Configuration> };
} = {};

export async function getOidcConfiguration() {
	const clientId = getClientId();
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
