import { auth } from "@/server/auth.server";

export const dynamic = "force-dynamic";

export async function GET() {
	return auth.startLogin();
}
