import { createFileRoute } from "@tanstack/react-router";
import * as oidc from "openid-client";
import { redirectResponse } from "../server/http.server";
import {
	logAuthFailure,
	logAuthWarning,
	sanitizeForLog,
} from "../server/log.server";
import { getAppUrl, getOidcConfiguration } from "../server/oidc.server";
import {
	createAppSession,
	getAuthTransactionSession,
} from "../server/session.server";

export const Route = createFileRoute("/auth/callback")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const transaction = await getAuthTransactionSession();
				const transactionData = transaction.data;
				const requestUrl = new URL(request.url);

				try {
					const state = requestUrl.searchParams.get("state");

					if (
						transactionData.flow !== "login" ||
						!transactionData.state ||
						!transactionData.nonce ||
						!transactionData.codeVerifier ||
						state !== transactionData.state
					) {
						throw new Error("Invalid OIDC transaction");
					}

					if (requestUrl.searchParams.has("error")) {
						logAuthWarning(
							"callback",
							`identity provider returned error=${sanitizeForLog(requestUrl.searchParams.get("error"))} description=${sanitizeForLog(requestUrl.searchParams.get("error_description"))}`,
						);
						await transaction.clear();
						return redirectResponse(getAppUrl("/"));
					}

					if (!requestUrl.searchParams.has("code")) {
						throw new Error("Missing authorization code");
					}

					const callbackUrl = getAppUrl("/auth/callback");
					callbackUrl.search = requestUrl.search;

					const configuration = await getOidcConfiguration();
					const tokens = await oidc.authorizationCodeGrant(
						configuration,
						callbackUrl,
						{
							pkceCodeVerifier: transactionData.codeVerifier,
							expectedState: transactionData.state,
							expectedNonce: transactionData.nonce,
							idTokenExpected: true,
						},
					);
					const claims = tokens.claims();

					if (
						!claims ||
						typeof claims.sub !== "string" ||
						typeof tokens.access_token !== "string" ||
						typeof tokens.refresh_token !== "string"
					) {
						throw new Error("OIDC response did not contain required tokens");
					}

					// ZITADEL only puts name and email in the ID token when the application
					// opts in, so ask the userinfo endpoint when the ID token has neither.
					let name = claims.name;
					let email = claims.email;
					if (typeof name !== "string" && typeof email !== "string") {
						try {
							const info = await oidc.fetchUserInfo(
								configuration,
								tokens.access_token,
								claims.sub,
							);
							name = info.name;
							email = info.email;
						} catch (error) {
							logAuthWarning("callback userinfo", error);
							// Signing in with the ID token identity alone is still valid.
						}
					}

					const user = {
						sub: claims.sub,
						...(typeof name === "string" ? { name } : {}),
						...(typeof email === "string" ? { email } : {}),
					};

					await createAppSession({
						user,
						accessToken: tokens.access_token,
						refreshToken: tokens.refresh_token,
						...(tokens.id_token ? { idToken: tokens.id_token } : {}),
						accessTokenExpiresAt:
							Date.now() + (tokens.expiresIn() ?? 300) * 1000,
					});
					await transaction.clear();

					return redirectResponse(getAppUrl("/dashboard"));
				} catch (error) {
					logAuthFailure("callback", error);
					await transaction.clear();
					return redirectResponse(getAppUrl("/"));
				}
			},
		},
	},
});
