import * as oidc from "openid-client";
import { AuthenticationRequiredError } from "./auth-error";
import {
	getAppOrigin,
	getAppUrl,
	getProjectAudienceScope,
	RESOURCE_OWNER_SCOPE,
} from "./config.server";
import { redirectResponse } from "./http.server";
import { logAuthFailure, logAuthWarning, sanitizeForLog } from "./log.server";
import { getOidcConfiguration } from "./oidc.server";
import {
	createAppSession,
	deleteAppSession,
	getAuthTransaction,
	readAppSession,
	updateAppSession,
} from "./session.server";
import type { StoredAuthSession } from "./session-record.server";
import { getSessionAgeMs } from "./session-record.server";

// The OIDC flows, written once for both frameworks: the route handlers under
// /auth only call these, and src/server/session.server.ts supplies the cookies.

const TOKEN_REFRESH_BUFFER_MS = 30_000;
// A token that was refused right after sign-in points at a misconfigured API,
// not a revocation. Dropping that session would loop through sign-in forever.
const REVOCATION_MIN_SESSION_AGE_MS = 60_000;

function plainTextResponse(body: string, status: number) {
	return new Response(body, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
}

/** GET /auth/login: sends the browser to ZITADEL with a new PKCE transaction. */
export async function startLogin(): Promise<Response> {
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
				RESOURCE_OWNER_SCOPE,
			].join(" "),
			state,
			nonce,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		const transaction = await getAuthTransaction();

		await transaction.update({
			flow: "login",
			state,
			nonce,
			codeVerifier,
		});

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

/** GET /auth/callback: trades the code for tokens and starts the app session. */
export async function finishLogin(request: Request): Promise<Response> {
	const transaction = await getAuthTransaction();
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
			accessTokenExpiresAt: Date.now() + (tokens.expiresIn() ?? 300) * 1000,
		});
		await transaction.clear();

		return redirectResponse(getAppUrl("/dashboard"));
	} catch (error) {
		logAuthFailure("callback", error);
		await transaction.clear();
		return redirectResponse(getAppUrl("/"));
	}
}

/**
 * POST /auth/logout: ends the app session, revokes its refresh token, and
 * sends the browser to ZITADEL to end the ZITADEL session too.
 */
export async function startLogout(request: Request): Promise<Response> {
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

	const transaction = await getAuthTransaction();
	const state = oidc.randomState();
	await transaction.update({ flow: "logout", state });

	try {
		const configuration = await getOidcConfiguration();
		if (appSession?.refreshToken) {
			try {
				await oidc.tokenRevocation(configuration, appSession.refreshToken);
			} catch (error) {
				logAuthWarning("logout token revocation", error);
				// Continue browser logout even if remote token revocation is unavailable.
			}
		}

		const logoutUrl = oidc.buildEndSessionUrl(configuration, {
			post_logout_redirect_uri: getAppUrl("/auth/logout/callback").href,
			state,
			...(appSession?.idToken ? { id_token_hint: appSession.idToken } : {}),
		});

		return redirectResponse(logoutUrl);
	} catch (error) {
		logAuthFailure("logout", error);
		await transaction.clear();
		return plainTextResponse("Unable to complete logout.", 503);
	}
}

/** GET /auth/logout/callback: ZITADEL is done; back to the home page. */
export async function finishLogout(request: Request): Promise<Response> {
	const transaction = await getAuthTransaction();
	const validState =
		transaction.data.flow === "logout" &&
		typeof transaction.data.state === "string" &&
		new URL(request.url).searchParams.get("state") === transaction.data.state;

	await transaction.clear();

	if (!validState) {
		return plainTextResponse("Invalid logout response.", 400);
	}

	return redirectResponse(getAppUrl("/"));
}

/**
 * The signed-in user's access token for an API call, refreshed first when it
 * is about to expire. Throws `AuthenticationRequiredError` when there is no
 * session or the refresh fails; the session is then gone.
 */
export async function getApiAccessToken(): Promise<string> {
	const session = await readAppSession();
	if (!session) throw new AuthenticationRequiredError();

	if (
		session.data.accessTokenExpiresAt >
		Date.now() + TOKEN_REFRESH_BUFFER_MS
	) {
		return session.data.accessToken;
	}

	try {
		const configuration = await getOidcConfiguration();
		const tokens = await oidc.refreshTokenGrant(
			configuration,
			session.data.refreshToken,
		);
		if (typeof tokens.access_token !== "string") {
			throw new Error("The token endpoint did not return an access token");
		}

		const expiresIn = tokens.expiresIn() ?? 300;
		const refreshedSession = {
			...session.data,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token ?? session.data.refreshToken,
			...(tokens.id_token ? { idToken: tokens.id_token } : {}),
			accessTokenExpiresAt: Date.now() + expiresIn * 1000,
		};
		await updateAppSession(session.id, refreshedSession);
		return refreshedSession.accessToken;
	} catch (error) {
		logAuthWarning("token refresh", error);
		await deleteAppSession().catch(() => undefined);
		throw new AuthenticationRequiredError();
	}
}

/**
 * The API rejected the access token although the session still looks valid:
 * ZITADEL revoked it (sign-out in another app shares one ZITADEL session, or the
 * user was deactivated). Removes the session so the next request starts a new
 * sign-in. Returns false for a session too young to have been revoked.
 */
export async function dropRevokedSession(): Promise<boolean> {
	const session = await readAppSession();
	if (
		session &&
		getSessionAgeMs(session.data) < REVOCATION_MIN_SESSION_AGE_MS
	) {
		return false;
	}
	logAuthWarning("api", "access token rejected; signing the user out");
	await deleteAppSession().catch(() => undefined);
	return true;
}
