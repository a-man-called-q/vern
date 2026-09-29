import { Button } from "@vern/ui/components/button";
import Link from "next/link";
import { getCurrentUser } from "../server/auth.server";

export default async function AuthControls() {
	const user = await getCurrentUser().catch(() => null);

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
				<Link href="/dashboard" title={user.name ?? user.email ?? user.sub}>
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
