/** A recorded request to the fake ZITADEL. */
export type Call = { method: string; url: string; headers: Headers; body: unknown };

/** A fake ZITADEL: answers each call in order and records what was sent. */
export function fakeZitadel(responses: { status?: number; body: unknown }[]) {
	const calls: Call[] = [];
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			method: init?.method ?? "GET",
			url: String(input),
			headers: new Headers(init?.headers),
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		const next = responses.shift();
		if (!next) throw new Error("unexpected extra request");
		return new Response(JSON.stringify(next.body), {
			status: next.status ?? 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
	return { calls, fetcher };
}
