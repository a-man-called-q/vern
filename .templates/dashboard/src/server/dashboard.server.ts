import { env } from "node:process";
import { fetchAuthenticatedApi } from "./api.server";
import type { DashboardData } from "./auth";
import { requireUser } from "./auth.server";

export async function getDashboardData(): Promise<DashboardData> {
	const user = await requireUser();
	if (!env.API_BASE_URL) return { user, apiStatus: "not-configured" };

	try {
		const response = await fetchAuthenticatedApi("/api/me");
		if (!response.ok) return { user, apiStatus: "unavailable" };

		const payload: unknown = await response.json();
		if (
			!payload ||
			typeof payload !== "object" ||
			typeof (payload as Record<string, unknown>).sub !== "string" ||
			(payload as Record<string, unknown>).sub !== user.sub
		) {
			return { user, apiStatus: "unavailable" };
		}

		return {
			user,
			apiStatus: "connected",
			apiSubject: (payload as { sub: string }).sub,
		};
	} catch {
		return { user, apiStatus: "unavailable" };
	}
}
