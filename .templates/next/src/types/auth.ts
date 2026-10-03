import type { AuthUser } from "@vern/web-auth/next";

export type { AuthUser };

export type DashboardData = {
	user: AuthUser;
	apiStatus: "not-configured" | "connected" | "unavailable";
	apiSubject?: string;
};
