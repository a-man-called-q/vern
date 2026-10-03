import { env } from "node:process";
import { logAuthWarning } from "@vern/web-auth/tanstack";
import { fetchAuthenticatedApi } from "./api.server";
import type { DashboardData } from "./auth";
import {
	AuthenticationRequiredError,
	redirectToLogin,
	requireUser,
} from "./auth.server";

export async function getDashboardData(): Promise<DashboardData> {
	const user = await requireUser();
	if (!env.API_BASE_URL) return { user, apiStatus: "not-configured" };

	try {
		const response = await fetchAuthenticatedApi("/api/me");
		if (!response.ok) {
			logAuthWarning("api /api/me", `HTTP ${response.status}`);
			return { user, apiStatus: "unavailable" };
		}

		const payload: unknown = await response.json();
		if (
			!payload ||
			typeof payload !== "object" ||
			typeof (payload as Record<string, unknown>).sub !== "string" ||
			(payload as Record<string, unknown>).sub !== user.sub
		) {
			logAuthWarning(
				"api /api/me",
				"response does not match the signed-in user",
			);
			return { user, apiStatus: "unavailable" };
		}

		return {
			user,
			apiStatus: "connected",
			apiSubject: (payload as { sub: string }).sub,
		};
	} catch (error) {
		// The session is gone (revoked token); a page that needs the API cannot
		// render without it, so sign in again.
		if (error instanceof AuthenticationRequiredError) return redirectToLogin();
		logAuthWarning("api /api/me", error);
		return { user, apiStatus: "unavailable" };
	}
}
