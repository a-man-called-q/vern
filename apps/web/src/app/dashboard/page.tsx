import { SidebarInset, SidebarProvider } from "@vern/ui/components/sidebar";
import type { CSSProperties } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { ChartAreaInteractive } from "@/components/chart-area-interactive";
import { DataTable } from "@/components/data-table";
import { SectionCards } from "@/components/section-cards";
import { SiteHeader } from "@/components/site-header";
import { SITE_NAME } from "@/lib/site";
import { getDashboardData } from "@/server/dashboard.server";
import dashboardData from "./data.json";

export default async function DashboardPage() {
	const { user, apiStatus } = await getDashboardData();

	return (
		<SidebarProvider
			className="dashboard-theme"
			style={
				{
					"--sidebar-width": "calc(var(--spacing) * 72)",
					"--header-height": "calc(var(--spacing) * 12)",
				} as CSSProperties
			}
		>
			<AppSidebar
				variant="inset"
				brandName={SITE_NAME}
				user={{
					name: user.name || user.email || `${SITE_NAME} user`,
					email: user.email || "",
					subject: user.sub,
				}}
				apiStatus={apiStatus}
			/>
			<SidebarInset>
				<SiteHeader />
				<div className="flex flex-1 flex-col">
					<div className="@container/main flex flex-1 flex-col gap-2">
						<div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
							<SectionCards />
							<div className="px-4 lg:px-6">
								<ChartAreaInteractive />
							</div>
							<DataTable data={dashboardData} />
						</div>
					</div>
				</div>
			</SidebarInset>
		</SidebarProvider>
	);
}
