"use client";

import { IconDotsVertical, IconLogout } from "@tabler/icons-react";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@vern/ui/components/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@vern/ui/components/dropdown-menu";
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@vern/ui/components/sidebar";

export type NavUserProps = {
	user: {
		name: string;
		email: string;
		avatar?: string;
		subject?: string;
	};
	/** Signing out is a POST, so that a link cannot do it. */
	logoutPath?: string;
};

function UserSummary({ user }: Pick<NavUserProps, "user">) {
	return (
		<div className="grid flex-1 text-left text-sm leading-tight">
			<span className="truncate font-medium">{user.name}</span>
			<span className="truncate text-xs text-muted-foreground">
				{user.email}
			</span>
		</div>
	);
}

export function NavUser({ user, logoutPath = "/auth/logout" }: NavUserProps) {
	const { isMobile } = useSidebar();
	const initials = user.name
		.split(/[\s@._-]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase())
		.join("");

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<SidebarMenuButton
							size="lg"
							className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
						>
							<Avatar className="h-8 w-8 rounded-lg grayscale">
								{user.avatar && (
									<AvatarImage src={user.avatar} alt={user.name} />
								)}
								<AvatarFallback className="rounded-lg">
									{initials || "?"}
								</AvatarFallback>
							</Avatar>
							<UserSummary user={user} />
							<IconDotsVertical className="ml-auto size-4" />
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
						side={isMobile ? "bottom" : "right"}
						align="end"
						sideOffset={4}
					>
						<DropdownMenuLabel className="p-0 font-normal">
							<div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
								<Avatar className="h-8 w-8 rounded-lg">
									{user.avatar && (
										<AvatarImage src={user.avatar} alt={user.name} />
									)}
									<AvatarFallback className="rounded-lg">
										{initials || "?"}
									</AvatarFallback>
								</Avatar>
								<UserSummary user={user} />
							</div>
						</DropdownMenuLabel>
						{user.subject && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuGroup>
									<DropdownMenuItem disabled className="max-w-56 truncate">
										ID: {user.subject}
									</DropdownMenuItem>
								</DropdownMenuGroup>
							</>
						)}
						<DropdownMenuSeparator />
						<form action={logoutPath} method="post">
							<DropdownMenuItem asChild>
								<button className="w-full" type="submit">
									<IconLogout />
									Sign out
								</button>
							</DropdownMenuItem>
						</form>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}
