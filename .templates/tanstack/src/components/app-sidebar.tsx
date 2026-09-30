import {
	IconCamera,
	IconChartBar,
	IconDashboard,
	IconDatabase,
	IconFileAi,
	IconFileDescription,
	IconFileWord,
	IconFolder,
	IconHelp,
	IconInnerShadowTop,
	IconListDetails,
	IconReport,
	IconSearch,
	IconSettings,
	IconUsers,
} from "@tabler/icons-react";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@vern/ui/components/sidebar";
import type * as React from "react";
import { NavDocuments } from "#/components/nav-documents.tsx";
import { NavMain } from "#/components/nav-main.tsx";
import { NavSecondary } from "#/components/nav-secondary.tsx";
import { NavUser } from "#/components/nav-user.tsx";

const data = {
	navMain: [
		{
			title: "Dashboard",
			url: "#",
			icon: IconDashboard,
		},
		{
			title: "Lifecycle",
			url: "#",
			icon: IconListDetails,
		},
		{
			title: "Analytics",
			url: "#",
			icon: IconChartBar,
		},
		{
			title: "Projects",
			url: "#",
			icon: IconFolder,
		},
		{
			title: "Team",
			url: "#",
			icon: IconUsers,
		},
	],
	navClouds: [
		{
			title: "Capture",
			icon: IconCamera,
			isActive: true,
			url: "#",
			items: [
				{
					title: "Active Proposals",
					url: "#",
				},
				{
					title: "Archived",
					url: "#",
				},
			],
		},
		{
			title: "Proposal",
			icon: IconFileDescription,
			url: "#",
			items: [
				{
					title: "Active Proposals",
					url: "#",
				},
				{
					title: "Archived",
					url: "#",
				},
			],
		},
		{
			title: "Prompts",
			icon: IconFileAi,
			url: "#",
			items: [
				{
					title: "Active Proposals",
					url: "#",
				},
				{
					title: "Archived",
					url: "#",
				},
			],
		},
	],
	navSecondary: [
		{
			title: "Settings",
			url: "#",
			icon: IconSettings,
		},
		{
			title: "Get Help",
			url: "#",
			icon: IconHelp,
		},
		{
			title: "Search",
			url: "#",
			icon: IconSearch,
		},
	],
	documents: [
		{
			name: "Data Library",
			url: "#",
			icon: IconDatabase,
		},
		{
			name: "Reports",
			url: "#",
			icon: IconReport,
		},
		{
			name: "Word Assistant",
			url: "#",
			icon: IconFileWord,
		},
	],
};

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
	brandName: string;
	user: {
		name: string;
		email: string;
		subject: string;
	};
	apiStatus: "connected" | "not-configured" | "unavailable";
};

export function AppSidebar({
	brandName,
	user,
	apiStatus,
	...props
}: AppSidebarProps) {
	const apiStatusLabel = {
		connected: "Connected",
		"not-configured": "Not configured",
		unavailable: "Unavailable",
	}[apiStatus];

	return (
		<Sidebar collapsible="offcanvas" {...props}>
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							asChild
							className="data-[slot=sidebar-menu-button]:p-1.5!"
						>
							<a href="#dashboard">
								<IconInnerShadowTop className="size-5!" />
								<span className="text-base font-semibold">{brandName}</span>
							</a>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>
			<SidebarContent>
				<NavMain items={data.navMain} />
				<NavDocuments items={data.documents} />
				<NavSecondary items={data.navSecondary} className="mt-auto" />
			</SidebarContent>
			<SidebarFooter>
				<div className="mx-2 rounded-lg border border-sidebar-border bg-sidebar-accent/40 px-3 py-2.5">
					<div className="flex items-center gap-2 text-xs font-medium">
						<span
							aria-hidden="true"
							className={`size-1.5 rounded-full ${apiStatus === "connected" ? "bg-emerald-500" : apiStatus === "not-configured" ? "bg-amber-500" : "bg-rose-500"}`}
						/>
						API connection
						<span className="ml-auto text-sidebar-foreground/60">
							{apiStatusLabel}
						</span>
					</div>
				</div>
				<NavUser user={user} />
			</SidebarFooter>
		</Sidebar>
	);
}
