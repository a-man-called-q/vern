import { finishLogout } from "@/server/auth-flow.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	return finishLogout(request);
}
