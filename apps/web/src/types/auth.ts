export type AuthUser = {
	sub: string;
	name?: string;
	email?: string;
};

export type DashboardData = {
	user: AuthUser;
	apiStatus: "not-configured" | "connected" | "unavailable";
	apiSubject?: string;
};
