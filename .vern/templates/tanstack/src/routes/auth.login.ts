import { createFileRoute } from "@tanstack/react-router";
import { auth } from "../server/auth.server";

export const Route = createFileRoute("/auth/login")({
	server: {
		handlers: {
			GET: () => auth.startLogin(),
		},
	},
});
