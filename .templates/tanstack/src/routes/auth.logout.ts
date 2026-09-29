import { createFileRoute } from "@tanstack/react-router";
import * as oidc from "openid-client";
import { redirectResponse } from "../server/http.server";
import { logAuthFailure, logAuthWarning } from "../server/log.server";
import {
	getAppOrigin,
	getAppUrl,
	getOidcConfiguration,
} from "../server/oidc.server";
import type { StoredAuthSession } from "../server/session.server";
import {
	deleteAppSession,
	getAuthTransactionSession,
} from "../server/session.server";

export const Route = createFileRoute("/auth/logout")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				if (request.headers.get("origin") !== getAppOrigin()) {
					return new Response("Forbidden", {
						status: 403,
						headers: { "Cache-Control": "no-store" },
					});
				}

				let appSession: StoredAuthSession | null = null;
				try {
					appSession = await deleteAppSession();
				} catch (error) {
					logAuthWarning("logout session cleanup", error);
					// The browser cookie is cleared before Redis is contacted.
				}

				const transaction = await getAuthTransactionSession();
				const state = oidc.randomState();
				await transaction.update({ flow: "logout", state });

				try {
					const configuration = await getOidcConfiguration();
					if (appSession?.refreshToken) {
						try {
							await oidc.tokenRevocation(
								configuration,
								appSession.refreshToken,
							);
						} catch (error) {
							logAuthWarning("logout token revocation", error);
							// Continue browser logout even if remote token revocation is unavailable.
						}
					}

					const logoutUrl = oidc.buildEndSessionUrl(configuration, {
						post_logout_redirect_uri: getAppUrl("/auth/logout/callback").href,
						state,
						...(appSession?.idToken
							? { id_token_hint: appSession.idToken }
							: {}),
					});

					return redirectResponse(logoutUrl);
				} catch (error) {
					logAuthFailure("logout", error);
					await transaction.clear();
					return new Response("Unable to complete logout.", {
						status: 503,
						headers: {
							"Cache-Control": "no-store",
							"Content-Type": "text/plain; charset=utf-8",
						},
					});
				}
			},
		},
	},
});
