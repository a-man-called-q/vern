import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { AuthUser } from "../types/auth";
import { AuthenticationRequiredError } from "./auth-error";
import { readAppSession } from "./session.server";

export { AuthenticationRequiredError };
export { dropRevokedSession, getApiAccessToken } from "./auth-flow.server";

/** Deduplicated per request, so the header and a page can both call it. */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
	const session = await readAppSession();
	return session?.data.user ?? null;
});

export async function requireUser(): Promise<AuthUser> {
	const user = await getCurrentUser();

	if (!user) {
		redirect("/auth/login");
	}

	return user;
}
