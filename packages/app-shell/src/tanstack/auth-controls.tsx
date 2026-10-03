import { Button } from "@vern/ui/components/button";
import { useEffect, useState } from "react";
import type { ShellUser } from "../nav";
import { RouterLink } from "./link";

export type AuthControlsProps = {
	/** Who is signed in, if anyone: a server function. A failure reads as signed out. */
	getUser: () => Promise<ShellUser | null>;
	loginPath?: string;
	logoutPath?: string;
	dashboardPath?: string;
};

export function AuthControls({
	getUser,
	loginPath = "/auth/login",
	logoutPath = "/auth/logout",
	dashboardPath = "/dashboard",
}: AuthControlsProps) {
	const [user, setUser] = useState<ShellUser | null>(null);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		let isMounted = true;

		getUser()
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
	}, [getUser]);

	if (isLoading) {
		return <span className="px-2 text-sm" aria-hidden="true" />;
	}

	if (!user) {
		return (
			<Button variant="ghost" size="sm" asChild>
				<a href={loginPath}>Log in</a>
			</Button>
		);
	}

	return (
		<div className="flex items-center gap-1">
			<Button variant="ghost" size="sm" asChild>
				<RouterLink
					href={dashboardPath}
					title={user.name ?? user.email ?? user.sub}
				>
					Logged in
				</RouterLink>
			</Button>
			<form action={logoutPath} method="post">
				<Button type="submit" variant="ghost" size="sm">
					Log out
				</Button>
			</form>
		</div>
	);
}
