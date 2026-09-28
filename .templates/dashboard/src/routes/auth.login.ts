import { createFileRoute } from "@tanstack/react-router";
import * as oidc from "openid-client";
import { redirectResponse } from "../server/http.server";
import {
	getAppUrl,
	getOidcConfiguration,
	getProjectAudienceScope,
} from "../server/oidc.server";
import { getAuthTransactionSession } from "../server/session.server";

export const Route = createFileRoute("/auth/login")({
	server: {
		handlers: {
			GET: async () => {
				const configuration = await getOidcConfiguration();
				const state = oidc.randomState();
				const nonce = oidc.randomNonce();
				const codeVerifier = oidc.randomPKCECodeVerifier();
				const codeChallenge =
					await oidc.calculatePKCECodeChallenge(codeVerifier);
				const authorizationUrl = oidc.buildAuthorizationUrl(configuration, {
					redirect_uri: getAppUrl("/auth/callback").href,
					response_type: "code",
					scope: [
						"openid",
						"profile",
						"email",
						"offline_access",
						getProjectAudienceScope(),
					].join(" "),
					state,
					nonce,
					code_challenge: codeChallenge,
					code_challenge_method: "S256",
				});
				const transaction = await getAuthTransactionSession();

				await transaction.update({
					flow: "login",
					state,
					nonce,
					codeVerifier,
				});

				return redirectResponse(authorizationUrl);
			},
		},
	},
});
