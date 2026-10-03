import { Button } from "@vern/ui/components/button";
import Link from "next/link";
import type { ShellUser } from "../nav";

export type AuthControlsProps = {
	/** Who is signed in, if anyone. A failure reads as signed out. */
	getUser: () => Promise<ShellUser | null>;
	loginPath?: string;
	logoutPath?: string;
	dashboardPath?: string;
};

export async function AuthControls({
	getUser,
	loginPath = "/auth/login",
	logoutPath = "/auth/logout",
	dashboardPath = "/dashboard",
}: AuthControlsProps) {
	const user = await getUser().catch(() => null);

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
				<Link href={dashboardPath} title={user.name ?? user.email ?? user.sub}>
					Logged in
				</Link>
			</Button>
			<form action={logoutPath} method="post">
				<Button type="submit" variant="ghost" size="sm">
					Log out
				</Button>
			</form>
		</div>
	);
}
