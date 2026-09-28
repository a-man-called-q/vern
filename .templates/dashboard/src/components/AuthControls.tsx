import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getCurrentUserFn } from "../server/auth";
import type { AuthUser } from "../types/auth";

export default function AuthControls() {
	const [user, setUser] = useState<AuthUser | null>(null);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		let isMounted = true;

		getCurrentUserFn()
			.then((currentUser) => {
				if (isMounted) setUser(currentUser);
			})
			.catch(() => {
				if (isMounted) setUser(null);
			})
			.finally(() => {
				if (isMounted) setIsLoading(false);
			});

		return () => {
			isMounted = false;
		};
	}, []);

	if (isLoading) {
		return <span className="px-2 text-sm" aria-hidden="true" />;
	}

	if (!user) {
		return (
			<a
				href="/auth/login"
				className="rounded-xl px-3 py-2 text-sm font-semibold text-[var(--sea-ink-soft)] no-underline transition hover:bg-[var(--link-bg-hover)] hover:text-[var(--sea-ink)]"
			>
				Log in
			</a>
		);
	}

	return (
		<div className="flex items-center gap-1">
			<Link
				to="/dashboard"
				className="max-w-36 truncate rounded-xl px-3 py-2 text-sm font-semibold text-[var(--sea-ink-soft)] no-underline transition hover:bg-[var(--link-bg-hover)] hover:text-[var(--sea-ink)]"
				title={user.name ?? user.email ?? user.sub}
			>
				{user.name ?? user.email ?? "Account"}
			</Link>
			<form action="/auth/logout" method="post">
				<button
					type="submit"
					className="rounded-xl px-3 py-2 text-sm font-semibold text-[var(--sea-ink-soft)] transition hover:bg-[var(--link-bg-hover)] hover:text-[var(--sea-ink)]"
				>
					Log out
				</button>
			</form>
		</div>
	);
}
