import { createFileRoute } from "@tanstack/react-router";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@vern/ui/components/card";
import { getDashboardDataFn } from "../server/auth";

export const Route = createFileRoute("/dashboard")({
	loader: () => getDashboardDataFn(),
	component: Dashboard,
});

function Dashboard() {
	const { user, apiStatus, apiSubject } = Route.useLoaderData();

	return (
		<main className="page-wrap px-4 py-12">
			<Card>
				<CardHeader>
					<p className="m-0 text-sm text-muted-foreground">
						Authenticated area
					</p>
					<CardTitle className="text-4xl font-bold sm:text-5xl">
						Dashboard
					</CardTitle>
				</CardHeader>
				<CardContent>
					<dl className="grid gap-4 text-sm sm:grid-cols-[8rem_1fr]">
						<dt className="font-semibold text-muted-foreground">Name</dt>
						<dd className="m-0">{user.name ?? "—"}</dd>
						<dt className="font-semibold text-muted-foreground">Email</dt>
						<dd className="m-0">{user.email ?? "—"}</dd>
						<dt className="font-semibold text-muted-foreground">Subject</dt>
						<dd className="m-0 break-all font-mono">{user.sub}</dd>
					</dl>
					<div className="mt-8 border-t pt-5">
						<h2 className="mb-2 text-lg font-semibold">Configured API</h2>
						{apiStatus === "connected" ? (
							<p className="m-0 text-sm text-muted-foreground">
								Axum verified this request through ZITADEL introspection for
								subject <code>{apiSubject}</code>.
							</p>
						) : apiStatus === "not-configured" ? (
							<p className="m-0 text-sm text-muted-foreground">
								Set <code>API_BASE_URL</code> to call an Axum API from this
								server.
							</p>
						) : (
							<p className="m-0 text-sm text-muted-foreground">
								The configured API could not verify this session. Check that the
								Axum API and ZITADEL are available.
							</p>
						)}
					</div>
				</CardContent>
			</Card>
		</main>
	);
}
