// What a load balancer or Kubernetes probe calls. Public on purpose: it needs no
// session and calls neither ZITADEL nor Redis, so it answers while the process
// can serve requests, whatever the state of those.
export const dynamic = "force-dynamic";

export function GET() {
	return Response.json(
		{ status: "ok" },
		{ headers: { "Cache-Control": "no-store" } },
	);
}
