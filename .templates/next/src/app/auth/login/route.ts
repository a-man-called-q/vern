import { startLogin } from "@/server/auth-flow.server";

export const dynamic = "force-dynamic";

export async function GET() {
	return startLogin();
}
