import { redirect } from "@tanstack/react-router";
import { createApiClientFactory } from "../core/api";
import { createAuthFlow } from "../core/auth-flow";
import type { AuthUser } from "../core/types";
import { createTanStackSessionStore } from "./session";

export { AuthenticationRequiredError } from "../core/auth-error";
export { logAuthFailure, logAuthWarning } from "../core/log";
export type { ApiFetch, AuthUser } from "../core/types";

export type WebAuthOptions = {
	/** Kebab-case app name; namespaces the cookies and the Redis keys per app. */
	appId: string;
	/** Where `requireUser` sends a visitor without a session. */
	loginPath?: string;
};

export type WebAuth = ReturnType<typeof createWebAuth>;

/**
 * Sign-in for one TanStack Start app: who the user is, the four `/auth` route
 * handlers, and calls to the APIs as that user. Make it once, in
 * `src/server/auth.server.ts`, and build on what it returns. Server code only:
 * browser code reaches it through a server function.
 */
export function createWebAuth({
	appId,
	loginPath = "/auth/login",
}: WebAuthOptions) {
	const sessions = createTanStackSessionStore(appId);
	const flow = createAuthFlow(sessions);

	async function getCurrentUser(): Promise<AuthUser | null> {
		const session = await sessions.read();
		return session?.data.user ?? null;
	}

	/**
	 * Sends the visitor to sign in. It never returns. `/auth/login` is answered
	 * by the server, so the browser loads it as a document.
	 */
	function redirectToLogin(): never {
		throw redirect({ href: loginPath });
	}

	async function requireUser(): Promise<AuthUser> {
		return (await getCurrentUser()) ?? redirectToLogin();
	}

	return {
		...flow,
		getCurrentUser,
		requireUser,
		redirectToLogin,
		/**
		 * `createApiClient("BILLING_API_URL")` is the server-only helper for the
		 * API whose base URL is in that variable. A call throws
		 * `AuthenticationRequiredError` when the session is gone.
		 */
		createApiClient: createApiClientFactory({
			getAccessToken: flow.getApiAccessToken,
			onUnauthorized: flow.dropRevokedSession,
		}),
	};
}
