export function redirectResponse(location: URL | string) {
	return new Response(null, {
		status: 302,
		headers: {
			Location: location.toString(),
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
		},
	});
}
