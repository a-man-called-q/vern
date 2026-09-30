import * as oidc from "openid-client";
import { redirectResponse } from "@/server/http.server";
import { logAuthFailure } from "@/server/log.server";
import {
	getAppUrl,
	getOidcConfiguration,
	getProjectAudienceScope,
} from "@/server/oidc.server";
import { getAuthTransactionSession } from "@/server/session.server";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		const configuration = await getOidcConfiguration();
		const state = oidc.randomState();
		const nonce = oidc.randomNonce();
		const codeVerifier = oidc.randomPKCECodeVerifier();
		const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
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

		transaction.flow = "login";
		transaction.state = state;
		transaction.nonce = nonce;
		transaction.codeVerifier = codeVerifier;
		await transaction.save();

		return redirectResponse(authorizationUrl);
	} catch (error) {
		// Usually configuration: APP_URL, ZITADEL_ISSUER, or an unreachable issuer.
		logAuthFailure("login", error);
		return new Response(
			"Sign-in is unavailable. The server log has the details.",
			{
				status: 500,
			},
		);
	}
}
