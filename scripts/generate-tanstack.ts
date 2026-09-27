import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const arguments_ = process.argv.slice(2);
let name: string | undefined;
const definitions: string[] = [];

for (let index = 0; index < arguments_.length; index += 1) {
	const argument = arguments_[index];

	if (argument === "--name") {
		name = arguments_[index + 1];
		index += 1;
		continue;
	}

	if (argument === "--define") {
		const definition = arguments_[index + 1];
		if (!definition) {
			throw new Error("Expected a value after --define.");
		}
		definitions.push(definition);
		index += 1;
		continue;
	}

	if (argument.startsWith("--define=")) {
		definitions.push(argument.slice("--define=".length));
		continue;
	}

	throw new Error(`Unsupported argument: ${argument}`);
}

if (!name || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
	throw new Error("Pass --name with a lowercase kebab-case app name.");
}

for (const definition of definitions) {
	if (!/^include_demos=(true|false)$/.test(definition)) {
		throw new Error(`Unsupported template definition: ${definition}`);
	}
}

const destination = resolve(repoRoot, "apps", name);
if (existsSync(destination)) {
	throw new Error(`Refusing to generate into an existing path: apps/${name}`);
}

// cargo-generate treats --destination as the parent directory; --name creates apps/<name>.
const command = [
	"cargo",
	"generate",
	"--path",
	".templates/tanstack",
	"--name",
	name,
	"--destination",
	resolve(repoRoot, "apps"),
	"--vcs",
	"none",
];

for (const definition of definitions) {
	command.push("--define", definition);
}

const result = Bun.spawnSync(command, {
	cwd: repoRoot,
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});

process.exit(result.exitCode);
