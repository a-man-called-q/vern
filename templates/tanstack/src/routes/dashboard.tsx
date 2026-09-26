import { createFileRoute } from "@tanstack/react-router";
import { getDashboardDataFn } from "../server/auth";

export const Route = createFileRoute("/dashboard")({
	loader: () => getDashboardDataFn(),
	component: Dashboard,
});

function Dashboard() {
	const { user, apiStatus, apiSubject } = Route.useLoaderData();

	return (
		<main className="page-wrap px-4 py-12">
			<section className="island-shell rounded-2xl p-6 sm:p-8">
				<p className="island-kicker mb-2">Authenticated area</p>
				<h1 className="display-title mb-5 text-4xl font-bold text-[var(--sea-ink)] sm:text-5xl">
					Dashboard
				</h1>
				<dl className="grid gap-4 text-sm sm:grid-cols-[8rem_1fr]">
					<dt className="font-semibold text-[var(--sea-ink-soft)]">Name</dt>
					<dd className="m-0 text-[var(--sea-ink)]">{user.name ?? "—"}</dd>
					<dt className="font-semibold text-[var(--sea-ink-soft)]">Email</dt>
					<dd className="m-0 text-[var(--sea-ink)]">{user.email ?? "—"}</dd>
					<dt className="font-semibold text-[var(--sea-ink-soft)]">Subject</dt>
					<dd className="m-0 break-all font-mono text-[var(--sea-ink)]">
						{user.sub}
					</dd>
				</dl>
				<div className="mt-8 border-t border-[rgba(23,58,64,0.12)] pt-5">
					<h2 className="mb-2 text-lg font-semibold text-[var(--sea-ink)]">
						Configured API
					</h2>
					{apiStatus === "connected" ? (
						<p className="m-0 text-sm text-[var(--sea-ink-soft)]">
							Axum verified this request through ZITADEL introspection for
							subject <code>{apiSubject}</code>.
						</p>
					) : apiStatus === "not-configured" ? (
						<p className="m-0 text-sm text-[var(--sea-ink-soft)]">
							Set <code>API_BASE_URL</code> to call an Axum API from this
							server.
						</p>
					) : (
						<p className="m-0 text-sm text-[var(--sea-ink-soft)]">
							The configured API could not verify this session. Check that the
							Axum API and ZITADEL are available.
						</p>
					)}
				</div>
			</section>
		</main>
	);
}
