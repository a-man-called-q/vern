"use client";

import { IconInnerShadowTop } from "@tabler/icons-react";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@vern/ui/components/sidebar";
import type { ComponentProps, ReactNode } from "react";
import type { NavGroup, ShellLink } from "../nav";
import { NavMain } from "./nav-main";
import { NavUser, type NavUserProps } from "./nav-user";

export type AppSidebarProps = Omit<
	ComponentProps<typeof Sidebar>,
	"content"
> & {
	brandName: string;
	/** Where the brand links to. */
	homePath?: string;
	navGroups: NavGroup[];
	user: NavUserProps["user"];
	link: ShellLink;
	pathname: string;
	/** More of the sidebar, under the navigation. */
	content?: ReactNode;
	/** Above the user's menu, at the foot of the sidebar. */
	footer?: ReactNode;
};

export function AppSidebar({
	brandName,
	homePath = "/dashboard",
	navGroups,
	user,
	link: Link,
	pathname,
	content,
	footer,
	...props
}: AppSidebarProps) {
	return (
		<Sidebar collapsible="offcanvas" {...props}>
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							asChild
							className="data-[slot=sidebar-menu-button]:p-1.5!"
						>
							<Link href={homePath}>
								<IconInnerShadowTop className="size-5!" />
								<span className="text-base font-semibold">{brandName}</span>
							</Link>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>
			<SidebarContent>
				<NavMain groups={navGroups} link={Link} pathname={pathname} />
				{content}
			</SidebarContent>
			<SidebarFooter>
				{footer}
				<NavUser user={user} />
			</SidebarFooter>
		</Sidebar>
	);
}
