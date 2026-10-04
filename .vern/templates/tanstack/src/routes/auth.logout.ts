import { createFileRoute } from "@tanstack/react-router";
import { auth } from "../server/auth.server";

export const Route = createFileRoute("/auth/logout")({
	server: {
		handlers: {
			POST: ({ request }) => auth.startLogout(request),
		},
	},
});
