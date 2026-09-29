import * as oidc from "openid-client";
import { redirectResponse } from "@/server/http.server";
import { getAppUrl, getOidcConfiguration } from "@/server/oidc.server";
import {
	createAppSession,
	getAuthTransactionSession,
} from "@/server/session.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const transaction = await getAuthTransactionSession();
	const requestUrl = new URL(request.url);

	try {
		const state = requestUrl.searchParams.get("state");

		if (
			transaction.flow !== "login" ||
			!transaction.state ||
			!transaction.nonce ||
			!transaction.codeVerifier ||
			state !== transaction.state
		) {
			throw new Error("Invalid OIDC transaction");
		}

		if (requestUrl.searchParams.has("error")) {
			transaction.destroy();
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
				pkceCodeVerifier: transaction.codeVerifier,
				expectedState: transaction.state,
				expectedNonce: transaction.nonce,
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

		const user = {
			sub: claims.sub,
			...(typeof claims.name === "string" ? { name: claims.name } : {}),
			...(typeof claims.email === "string" ? { email: claims.email } : {}),
		};

		await createAppSession({
			user,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			...(tokens.id_token ? { idToken: tokens.id_token } : {}),
			accessTokenExpiresAt: Date.now() + (tokens.expiresIn() ?? 300) * 1000,
		});
		transaction.destroy();

		return redirectResponse(getAppUrl("/dashboard"));
	} catch {
		transaction.destroy();
		return redirectResponse(getAppUrl("/"));
	}
}
