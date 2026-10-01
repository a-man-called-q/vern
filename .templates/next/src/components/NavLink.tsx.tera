"use client";

import { cn } from "@vern/ui/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentProps } from "react";

type NavLinkProps = ComponentProps<typeof Link> & { href: string };

/** A Link that gets the active style when the current route matches. */
export default function NavLink({ href, className, ...props }: NavLinkProps) {
	const pathname = usePathname();
	const isActive =
		href === "/"
			? pathname === "/"
			: pathname === href || pathname.startsWith(`${href}/`);

	return (
		<Link
			href={href}
			aria-current={isActive ? "page" : undefined}
			className={cn(className, isActive && "text-foreground")}
			{...props}
		/>
	);
}
