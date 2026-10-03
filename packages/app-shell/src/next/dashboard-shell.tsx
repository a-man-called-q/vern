"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
	DashboardFrame,
	type DashboardShellProps,
} from "../components/dashboard-frame";

/**
 * The sidebar and header around every page under /dashboard, for a Next.js
 * app: use it in `src/app/dashboard/layout.tsx`. A layout does not render again
 * when you move between those pages, so each page that needs a user still
 * calls `requireUser()`.
 */
export function DashboardShell(props: DashboardShellProps) {
	return <DashboardFrame {...props} link={Link} pathname={usePathname()} />;
}
