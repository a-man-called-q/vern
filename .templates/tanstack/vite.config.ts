import { env } from "node:process";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const config = defineConfig(({ command, mode }) => {
	const portValue = env.PORT ?? loadEnv(mode, process.cwd(), "PORT").PORT;
	const port = Number(portValue);
	if (
		command === "serve" &&
		(!Number.isInteger(port) || port < 1 || port > 65535)
	) {
		throw new Error(
			"Set PORT to a valid TCP port before starting the TanStack app.",
		);
	}

	return {
		resolve: { tsconfigPaths: true },
		plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
		server: command === "serve" ? { port, strictPort: true } : undefined,
		// Bundle the server's npm dependencies so the production image needs no
		// node_modules (see Dockerfile).
		ssr: command === "build" ? { noExternal: true } : undefined,
	};
});

export default config;
