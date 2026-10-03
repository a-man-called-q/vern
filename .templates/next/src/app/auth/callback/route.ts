import { auth } from "@/server/auth.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	return auth.finishLogin(request);
}
