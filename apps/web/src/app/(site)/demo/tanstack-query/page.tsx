"use client";

import { useQuery } from "@tanstack/react-query";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@vern/ui/components/card";

export default function TanStackQueryDemo() {
	const { data } = useQuery({
		queryKey: ["todos"],
		queryFn: () =>
			Promise.resolve([
				{ id: 1, name: "Alice" },
				{ id: 2, name: "Bob" },
				{ id: 3, name: "Charlie" },
			]),
		initialData: [],
	});

	return (
		<main className="mx-auto w-full max-w-2xl px-4 py-12">
			<Card>
				<CardHeader>
					<p className="m-0 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
						TanStack Query
					</p>
					<CardTitle className="text-3xl">
						TanStack Query Simple Promise Handling
					</CardTitle>
					<CardDescription>Loaded with a TanStack Query hook.</CardDescription>
				</CardHeader>
				<CardContent>
					<ul className="mb-4 space-y-2">
						{data.map((todo) => (
							<li key={todo.id} className="rounded-md border px-3 py-2">
								<span className="text-base font-medium">{todo.name}</span>
							</li>
						))}
					</ul>
				</CardContent>
			</Card>
		</main>
	);
}
