import { redirectResponse } from "@/server/http.server";
import { getAppUrl } from "@/server/oidc.server";
import { getAuthTransactionSession } from "@/server/session.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const transaction = await getAuthTransactionSession();
	const validState =
		transaction.flow === "logout" &&
		typeof transaction.state === "string" &&
		new URL(request.url).searchParams.get("state") === transaction.state;

	transaction.destroy();

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
}
