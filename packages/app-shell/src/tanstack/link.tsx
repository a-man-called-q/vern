import { Link, type LinkProps } from "@tanstack/react-router";
import type { ShellLinkProps } from "../nav";

/**
 * TanStack Router's link, taking a path as `href` the way the shell's
 * components give it. The router checks `to` against the app's routes; a path
 * that arrives as data (a navigation item) is the app's to get right.
 */
export function RouterLink({ href, ...props }: ShellLinkProps) {
	return <Link to={href as LinkProps["to"]} {...props} />;
}
