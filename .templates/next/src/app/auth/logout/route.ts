import { startLogout } from "@/server/auth-flow.server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	return startLogout(request);
}
