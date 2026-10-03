import type { ComponentProps, ComponentType, ReactNode } from "react";

export type NavItem = {
	title: string;
	/** A path of the app, such as `/dashboard/invoices`. */
	url: string;
	/** A rendered icon (`<IconDashboard />`), so a Server Component can supply it. */
	icon?: ReactNode;
};

/**
 * A group without a label is a plain run of items, like the one that holds the
 * dashboard itself.
 */
export type NavGroup = {
	label?: string;
	items: NavItem[];
};

/** The signed-in user as the shell shows them. */
export type ShellUser = {
	sub: string;
	name?: string;
	email?: string;
};

export type ShellLinkProps = ComponentProps<"a"> & { href: string };

/**
 * The link of the app's framework, which moves between pages without loading
 * the document again. `next/dashboard-shell` and `tanstack/dashboard-shell`
 * supply it, so the components in `components/` name no framework.
 */
export type ShellLink = ComponentType<ShellLinkProps>;
