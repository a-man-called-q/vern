import { finishLogin } from "@/server/auth-flow.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	return finishLogin(request);
}
