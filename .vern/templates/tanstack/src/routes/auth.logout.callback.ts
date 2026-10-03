import { createFileRoute } from "@tanstack/react-router";
import { auth } from "../server/auth.server";

export const Route = createFileRoute("/auth/logout/callback")({
	server: {
		handlers: {
			GET: ({ request }) => auth.finishLogout(request),
		},
	},
});
