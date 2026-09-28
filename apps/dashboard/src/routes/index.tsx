import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@vern/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@vern/ui/components/card";

export const Route = createFileRoute("/")({ component: App });

const features = [
	["Type-Safe Routing", "Routes and links stay in sync across every page."],
	[
		"Server Functions",
		"Call server code from your UI without creating API boilerplate.",
	],
	[
		"Streaming by Default",
		"Ship progressively rendered responses for faster experiences.",
	],
	[
		"Tailwind Native",
		"Design quickly with utility-first styling and reusable tokens.",
	],
];

function App() {
	return (
		<main className="page-wrap space-y-8 px-4 py-12 sm:py-16">
			<Card className="overflow-hidden">
				<CardHeader className="gap-4 p-6 sm:p-10">
					<p className="m-0 text-xs font-semibold tracking-widest text-muted-foreground uppercase">
						TanStack Start base template
					</p>
					<CardTitle className="max-w-3xl text-4xl leading-tight font-bold tracking-tight sm:text-6xl">
						Start simple, ship quickly.
					</CardTitle>
					<CardDescription className="max-w-2xl text-base sm:text-lg">
						This base starter intentionally keeps things light: two routes,
						clean structure, and the essentials you need to build from scratch.
					</CardDescription>
					<div className="flex flex-wrap gap-3">
						<Button asChild>
							<Link to="/about">About this starter</Link>
						</Button>
						<Button variant="outline" asChild>
							<a
								href="https://tanstack.com/router"
								target="_blank"
								rel="noopener noreferrer"
							>
								Router guide
							</a>
						</Button>
					</div>
				</CardHeader>
			</Card>

			<section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				{features.map(([title, description]) => (
					<Card key={title}>
						<CardHeader className="gap-2 p-5">
							<CardTitle className="text-base">{title}</CardTitle>
							<CardDescription>{description}</CardDescription>
						</CardHeader>
					</Card>
				))}
			</section>

			<Card>
				<CardHeader>
					<CardTitle>Quick start</CardTitle>
					<CardDescription>Make this starter your own.</CardDescription>
				</CardHeader>
				<CardContent>
					<ul className="m-0 list-disc space-y-2 pl-5 text-sm text-muted-foreground">
						<li>
							Edit <code>src/routes/index.tsx</code> to customize the home page.
						</li>
						<li>
							Update <code>src/components/Header.tsx</code> and{" "}
							<code>src/components/Footer.tsx</code> for brand links.
						</li>
						<li>
							Add routes in <code>src/routes</code> and reuse components from{" "}
							<code>@vern/ui</code>.
						</li>
					</ul>
				</CardContent>
			</Card>
		</main>
	);
}
