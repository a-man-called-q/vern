import type { ReactNode } from "react";
import type { ShellLink } from "../nav";
import { ThemeToggle } from "./theme-toggle";

export type SiteHeaderProps = {
	siteName: string;
	link: ShellLink;
	/** Links to the public pages, after the name. */
	nav?: ReactNode;
	/** "Log in", or the way to the dashboard and out: the framework's `AuthControls`. */
	auth: ReactNode;
};

/** The header of the pages a visitor sees before signing in. */
export function SiteHeader({
	siteName,
	link: Link,
	nav,
	auth,
}: SiteHeaderProps) {
	return (
		<header className="sticky top-0 z-50 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
			<nav className="page-wrap flex min-h-16 items-center gap-3">
				<Link
					className="rounded-md px-2 py-1 text-base font-bold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					href="/"
				>
					{siteName}
				</Link>
				{nav}
				<div className="ml-auto flex items-center gap-1">
					{auth}
					<ThemeToggle />
				</div>
			</nav>
		</header>
	);
}
