import { createFileRoute } from "@tanstack/react-router";
import { auth } from "../server/auth.server";

export const Route = createFileRoute("/auth/callback")({
	server: {
		handlers: {
			GET: ({ request }) => auth.finishLogin(request),
		},
	},
});
