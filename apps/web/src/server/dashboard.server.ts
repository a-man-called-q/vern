import "server-only";
import { env } from "node:process";
import type { DashboardData } from "../types/auth";
import { fetchAuthenticatedApi } from "./api.server";
import { requireUser } from "./auth.server";
import { logAuthWarning } from "./log.server";

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
		logAuthWarning("api /api/me", error);
		return { user, apiStatus: "unavailable" };
	}
}
