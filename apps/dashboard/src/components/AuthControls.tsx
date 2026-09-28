import { Link } from "@tanstack/react-router";
import { Button } from "@vern/ui/components/button";
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
			<Button variant="ghost" size="sm" asChild>
				<a href="/auth/login">Log in</a>
			</Button>
		);
	}

	return (
		<div className="flex items-center gap-1">
			<Button variant="ghost" size="sm" asChild>
				<Link to="/dashboard" title={user.name ?? user.email ?? user.sub}>
					Logged in
				</Link>
			</Button>
			<form action="/auth/logout" method="post">
				<Button type="submit" variant="ghost" size="sm">
					Log out
				</Button>
			</form>
		</div>
	);
}
