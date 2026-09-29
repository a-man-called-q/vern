import { spawn } from "node:child_process";
import process from "node:process";

// Next.js reads PORT before it loads `.env` files, so read it here (Bun loads
// `.env` for this script) and pass it explicitly. Moon also injects it.
const [command, ...args] = process.argv.slice(2);
if (command !== "dev" && command !== "start") {
	console.error("Usage: bun scripts/next.ts <dev|start>");
	process.exit(1);
}

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
	console.error(
		"Set PORT to a valid TCP port before starting the Next.js app.",
	);
	process.exit(1);
}

const child = spawn(
	process.execPath,
	["--bun", "run", "next", command, "--port", String(port), ...args],
	{ stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 1));
