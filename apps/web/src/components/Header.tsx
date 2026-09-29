import { Button } from "@vern/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@vern/ui/components/dropdown-menu";
import Link from "next/link";
import { Suspense } from "react";
import { SITE_NAME } from "@/lib/site";
import AuthControls from "./AuthControls";
import NavLink from "./NavLink";
import ThemeToggle from "./ThemeToggle";

export default function Header() {
	return (
		<header className="sticky top-0 z-50 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
			<nav className="page-wrap flex min-h-16 items-center gap-3">
				<Link
					className="rounded-md px-2 py-1 text-base font-bold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					href="/"
				>
					{SITE_NAME}
				</Link>
				<div className="flex items-center gap-1">
					<Button variant="ghost" size="sm" asChild>
						<NavLink href="/">Home</NavLink>
					</Button>
					<Button variant="ghost" size="sm" asChild>
						<NavLink href="/about">About</NavLink>
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="sm">
								Demos
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							<DropdownMenuItem asChild>
								<Link href="/demo/form/simple">Simple Form</Link>
							</DropdownMenuItem>
							<DropdownMenuItem asChild>
								<Link href="/demo/form/address">Address Form</Link>
							</DropdownMenuItem>
							<DropdownMenuItem asChild>
								<Link href="/demo/table">TanStack Table</Link>
							</DropdownMenuItem>
							<DropdownMenuItem asChild>
								<Link href="/demo/tanstack-query">TanStack Query</Link>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<div className="ml-auto flex items-center gap-1">
					<Suspense
						fallback={<span className="px-2 text-sm" aria-hidden="true" />}
					>
						<AuthControls />
					</Suspense>
					<ThemeToggle />
				</div>
			</nav>
		</header>
	);
}
