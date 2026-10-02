import { createFileRoute } from "@tanstack/react-router";
import { startLogout } from "../server/auth-flow.server";

export const Route = createFileRoute("/auth/logout")({
	server: {
		handlers: {
			POST: ({ request }) => startLogout(request),
		},
	},
});
