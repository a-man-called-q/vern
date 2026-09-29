import * as oidc from "openid-client";
import type { AuthUser } from "../types/auth";
import { logAuthWarning } from "./log.server";
import { getOidcConfiguration } from "./oidc.server";
import {
	deleteAppSession,
	readAppSession,
	updateAppSession,
} from "./session.server";

const TOKEN_REFRESH_BUFFER_MS = 30_000;

export class AuthenticationRequiredError extends Error {
	constructor() {
		super("A valid signed-in session is required");
		this.name = "AuthenticationRequiredError";
	}
}

export async function getCurrentUser(): Promise<AuthUser | null> {
	const session = await readAppSession();
	return session?.data.user ?? null;
}

export async function requireUser(): Promise<AuthUser> {
	const user = await getCurrentUser();

	if (!user) {
		const { redirect } = await import("@tanstack/react-router");
		throw redirect({ to: "/auth/login" });
	}

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
