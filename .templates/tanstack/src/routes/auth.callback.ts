import { createFileRoute } from "@tanstack/react-router";
import { finishLogin } from "../server/auth-flow.server";

export const Route = createFileRoute("/auth/callback")({
	server: {
		handlers: {
			GET: ({ request }) => finishLogin(request),
		},
	},
});
