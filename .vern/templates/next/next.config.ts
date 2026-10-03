import { resolve } from "node:path";
import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

// Baseline hardening that is safe for any app. A script-src Content Security
// Policy needs a per-request nonce; add one with a proxy when you need it:
// https://nextjs.org/docs/app/guides/content-security-policy
const securityHeaders = [
	{ key: "X-Content-Type-Options", value: "nosniff" },
	{ key: "X-Frame-Options", value: "DENY" },
	{
		key: "Permissions-Policy",
		value: "camera=(), microphone=(), geolocation=()",
	},
	{
		key: "Content-Security-Policy",
		value: "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
	},
	// Browsers ignore HSTS over plain HTTP, and local development uses HTTP.
	...(isProduction
		? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]
		: []),
];

// The Docker image builds with NEXT_OUTPUT=standalone and runs the standalone
// server. Tracing from the monorepo root (two levels up from this app, where
// `next build` runs) includes workspace packages such as @vern/ui.
const standalone =
	process.env.NEXT_OUTPUT === "standalone"
		? {
				output: "standalone" as const,
				outputFileTracingRoot: resolve(process.cwd(), "../.."),
			}
		: {};

const nextConfig: NextConfig = {
	...standalone,
	reactCompiler: true,
	poweredByHeader: false,
	async headers() {
		return [
			{ source: "/:path*", headers: securityHeaders },
			// The /auth route handlers send a stricter `no-referrer` of their own, and
			// a matching header here would replace it.
			{
				source: "/((?!auth/).*)",
				headers: [
					{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
				],
			},
		];
	},
};

export default nextConfig;
