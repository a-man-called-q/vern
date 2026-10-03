/// <reference types="bun" />
import { resolve, sep } from "node:path";
import process from "node:process";

// Production server for `bun run start`: serves the built client assets and
// hands every other request to the TanStack Start handler from `vite build`.
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
	console.error(
		"Set PORT to a valid TCP port before starting the TanStack app.",
	);
	process.exit(1);
}

const clientDir = resolve(import.meta.dir, "../dist/client");
const { default: handler } = (await import(
	resolve(import.meta.dir, "../dist/server/server.js")
)) as {
	default: { fetch: (request: Request) => Promise<Response> };
};

async function staticFile(pathname: string): Promise<Response | undefined> {
	if (pathname === "/" || pathname.endsWith("/")) return undefined;
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return undefined;
	}
	const path = resolve(clientDir, `.${decoded}`);
	if (!path.startsWith(clientDir + sep)) return undefined;
	const file = Bun.file(path);
	if (!(await file.exists())) return undefined;
	// Vite fingerprints everything under /assets, so those never change.
	const cacheControl = decoded.startsWith("/assets/")
		? "public, max-age=31536000, immutable"
		: "public, max-age=3600";
	return new Response(file, { headers: { "Cache-Control": cacheControl } });
}

const server = Bun.serve({
	port,
	hostname: process.env.HOST ?? "0.0.0.0",
	async fetch(request) {
		if (request.method === "GET" || request.method === "HEAD") {
			const file = await staticFile(new URL(request.url).pathname);
			if (file) return file;
		}
		return handler.fetch(request);
	},
});

console.log(`Listening on http://${server.hostname}:${server.port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		server.stop();
		process.exit(0);
	});
}
