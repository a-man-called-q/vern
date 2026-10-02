import { createFileRoute } from "@tanstack/react-router";
import { startLogin } from "../server/auth-flow.server";

export const Route = createFileRoute("/auth/login")({
	server: {
		handlers: {
			GET: () => startLogin(),
		},
	},
});
