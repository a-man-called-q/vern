import type { AuthUser } from "../types/auth";
import { AuthenticationRequiredError } from "./auth-error";
import { readAppSession } from "./session.server";

export { dropRevokedSession, getApiAccessToken } from "./auth-flow.server";
export { AuthenticationRequiredError };

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
