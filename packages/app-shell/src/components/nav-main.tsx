"use client";

import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@vern/ui/components/sidebar";
import type { NavGroup, ShellLink } from "../nav";

export type NavMainProps = {
	groups: NavGroup[];
	link: ShellLink;
	/** The path of the page on screen, which picks the item shown as current. */
	pathname: string;
};

export function NavMain({ groups, link: Link, pathname }: NavMainProps) {
	// The most specific item wins, so /dashboard/projects does not also light up
	// /dashboard.
	const current = groups
		.flatMap((group) => group.items)
		.filter(
			(item) => pathname === item.url || pathname.startsWith(`${item.url}/`),
		)
		.sort((a, b) => b.url.length - a.url.length)[0];

	return groups.map((group) => (
		<SidebarGroup key={group.label ?? group.items[0]?.url}>
			{group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
			<SidebarGroupContent>
				<SidebarMenu>
					{group.items.map((item) => (
						<SidebarMenuItem key={item.url}>
							<SidebarMenuButton
								asChild
								tooltip={item.title}
								isActive={item === current}
							>
								<Link href={item.url}>
									{item.icon}
									<span>{item.title}</span>
								</Link>
							</SidebarMenuButton>
						</SidebarMenuItem>
					))}
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	));
}
