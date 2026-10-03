import { useRouterState } from "@tanstack/react-router";
import {
	DashboardFrame,
	type DashboardShellProps,
} from "../components/dashboard-frame";
import { RouterLink } from "./link";

/**
 * The sidebar and header around every route under /dashboard, for a TanStack
 * Start app: use it in `src/routes/dashboard.tsx`, around the `<Outlet />`.
 */
export function DashboardShell(props: DashboardShellProps) {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	return <DashboardFrame {...props} link={RouterLink} pathname={pathname} />;
}
