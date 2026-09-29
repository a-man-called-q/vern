import { Link } from "@tanstack/react-router";
import { Button } from "@vern/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@vern/ui/components/dropdown-menu";
import AuthControls from "./AuthControls";
import ThemeToggle from "./ThemeToggle";

export default function Header() {
	return (
		<header className="sticky top-0 z-50 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
			<nav className="page-wrap flex min-h-16 items-center gap-3">
				<Link
					className="rounded-md px-2 py-1 text-base font-bold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					to="/"
				>
					Vern
				</Link>
				<div className="flex items-center gap-1">
					<Button variant="ghost" size="sm" asChild>
						<Link to="/" activeProps={{ className: "text-foreground" }}>
							Home
						</Link>
					</Button>
					<Button variant="ghost" size="sm" asChild>
						<Link to="/about" activeProps={{ className: "text-foreground" }}>
							About
						</Link>
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="sm">
								Demos
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							<DropdownMenuItem asChild>
								<Link to="/demo/form/simple">Simple Form</Link>
							</DropdownMenuItem>
							<DropdownMenuItem asChild>
								<Link to="/demo/form/address">Address Form</Link>
							</DropdownMenuItem>
							<DropdownMenuItem asChild>
								<Link to="/demo/table">TanStack Table</Link>
							</DropdownMenuItem>
							<DropdownMenuItem asChild>
								<Link to="/demo/tanstack-query">TanStack Query</Link>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<div className="ml-auto flex items-center gap-1">
					<AuthControls />
					<Button
						variant="ghost"
						size="icon"
						className="hidden sm:inline-flex"
						asChild
					>
						<a
							href="https://github.com/a-man-called-q/vern"
							target="_blank"
							rel="noreferrer"
							aria-label="Vern on GitHub"
						>
							<span className="sr-only">Vern on GitHub</span>
							<svg
								aria-hidden="true"
								fill="currentColor"
								viewBox="0 0 16 16"
								className="size-4"
							>
								<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-1.04 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
							</svg>
						</a>
					</Button>
					<ThemeToggle />
				</div>
			</nav>
		</header>
	);
}
