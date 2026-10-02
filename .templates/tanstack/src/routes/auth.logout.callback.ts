import { createFileRoute } from "@tanstack/react-router";
import { finishLogout } from "../server/auth-flow.server";

export const Route = createFileRoute("/auth/logout/callback")({
	server: {
		handlers: {
			GET: ({ request }) => finishLogout(request),
		},
	},
});
