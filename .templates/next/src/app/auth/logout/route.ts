import { auth } from "@/server/auth.server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	return auth.startLogout(request);
}
