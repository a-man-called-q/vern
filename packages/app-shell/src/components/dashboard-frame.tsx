import { SidebarInset, SidebarProvider } from "@vern/ui/components/sidebar";
import type { CSSProperties, ReactNode } from "react";
import type { NavGroup, ShellLink, ShellUser } from "../nav";
import { AppSidebar } from "./app-sidebar";
import { DashboardHeader } from "./dashboard-header";

const SHELL_SIZES = {
	"--sidebar-width": "calc(var(--spacing) * 72)",
	"--header-height": "calc(var(--spacing) * 12)",
} as CSSProperties;

export type DashboardFrameProps = {
	/** The app's name: the brand in the sidebar, and the header's title. */
	siteName: string;
	user: ShellUser;
	/** The pages of the dashboard, in the groups the sidebar shows them in. */
	navGroups: NavGroup[];
	link: ShellLink;
	pathname: string;
	/** More of the sidebar, under the navigation. */
	sidebarContent?: ReactNode;
	/** Above the user's menu, at the foot of the sidebar. */
	sidebarFooter?: ReactNode;
	/** Beside the theme toggle, at the end of the header. */
	headerActions?: ReactNode;
	children: ReactNode;
};

/**
 * The sidebar and header around every page under /dashboard. An app uses it
 * through `next/dashboard-shell` or `tanstack/dashboard-shell`, which supply
 * the framework's link and the current path.
 */
export function DashboardFrame({
	siteName,
	user,
	navGroups,
	link,
	pathname,
	sidebarContent,
	sidebarFooter,
	headerActions,
	children,
}: DashboardFrameProps) {
	return (
		<SidebarProvider className="dashboard-theme" style={SHELL_SIZES}>
			<AppSidebar
				variant="inset"
				brandName={siteName}
				navGroups={navGroups}
				user={{
					name: user.name || user.email || `${siteName} user`,
					email: user.email || "",
					subject: user.sub,
				}}
				link={link}
				pathname={pathname}
				content={sidebarContent}
				footer={sidebarFooter}
			/>
			<SidebarInset>
				<DashboardHeader title={siteName} actions={headerActions} />
				{children}
			</SidebarInset>
		</SidebarProvider>
	);
}

/** What an app passes to the dashboard shell of its framework. */
export type DashboardShellProps = Omit<
	DashboardFrameProps,
	"link" | "pathname"
>;
