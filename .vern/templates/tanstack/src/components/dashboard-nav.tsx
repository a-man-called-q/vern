import { IconDashboard } from "@tabler/icons-react";
import type { NavGroup } from "@vern/app-shell/nav";

// The pages of the dashboard, as the sidebar groups them. To add a page, create
// its route under src/routes/dashboard and add an item to the group it belongs
// to; a group with a `label` gets a heading.
export const navGroups: NavGroup[] = [
	{
		items: [{ title: "Dashboard", url: "/dashboard", icon: <IconDashboard /> }],
	},
];
