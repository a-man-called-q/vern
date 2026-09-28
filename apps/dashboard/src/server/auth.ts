import { createServerFn } from "@tanstack/react-start";
import type { AuthUser } from "../types/auth";

export type DashboardData = {
	user: AuthUser;
	apiStatus: "not-configured" | "connected" | "unavailable";
	apiSubject?: string;
};

export const getCurrentUserFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<AuthUser | null> => {
		const { getCurrentUser } = await import("./auth.server");
		return getCurrentUser();
	},
);

export const getDashboardDataFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<DashboardData> => {
		const { getDashboardData } = await import("./dashboard.server");
		return getDashboardData();
	},
);
