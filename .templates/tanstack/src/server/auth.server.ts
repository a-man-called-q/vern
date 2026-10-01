import * as oidc from "openid-client";
import type { AuthUser } from "../types/auth";
import { AuthenticationRequiredError } from "./auth-error";
import { logAuthWarning } from "./log.server";
import { getOidcConfiguration } from "./oidc.server";
import {
	deleteAppSession,
	getSessionAgeMs,
	readAppSession,
	updateAppSession,
} from "./session.server";

const TOKEN_REFRESH_BUFFER_MS = 30_000;

export { AuthenticationRequiredError };

// A token that was refused right after sign-in points at a misconfigured API,
// not a revocation. Dropping that session would loop through sign-in forever.
const REVOCATION_MIN_SESSION_AGE_MS = 60_000;

export async function getCurrentUser(): Promise<AuthUser | null> {
	const session = await readAppSession();
	return session?.data.user ?? null;
}

export async function redirectToLogin(): Promise<never> {
	const { redirect } = await import("@tanstack/react-router");
	throw redirect({ to: "/auth/login" });
}

export async function requireUser(): Promise<AuthUser> {
	const user = await getCurrentUser();

	if (!user) return redirectToLogin();

	return user;
}

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
