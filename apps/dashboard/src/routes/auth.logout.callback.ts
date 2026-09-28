import { createFileRoute } from "@tanstack/react-router";
import { redirectResponse } from "../server/http.server";
import { getAppUrl } from "../server/oidc.server";
import { getAuthTransactionSession } from "../server/session.server";

export const Route = createFileRoute("/auth/logout/callback")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const transaction = await getAuthTransactionSession();
				const validState =
					transaction.data.flow === "logout" &&
					typeof transaction.data.state === "string" &&
					new URL(request.url).searchParams.get("state") ===
						transaction.data.state;

				await transaction.clear();

				if (!validState) {
					return new Response("Invalid logout response.", {
						status: 400,
						headers: {
							"Cache-Control": "no-store",
							"Content-Type": "text/plain; charset=utf-8",
						},
					});
				}

				return redirectResponse(getAppUrl("/"));
			},
		},
	},
});
