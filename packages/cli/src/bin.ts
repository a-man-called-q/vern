#!/usr/bin/env bun
import { checkPortsCommand } from "./check-ports";
import { doctorCommand } from "./doctor";
import { runCommand } from "./lib/cli";
import { CLI_BIN, COMMANDS, type CommandName } from "./lib/commands";
import { renameCommand } from "./rename";
import { setup } from "./setup/setup";
import { stackCommand } from "./stack";
import { updateCommand } from "./update";
import { main as zitadelApp } from "./zitadel-app";
import { main as zitadelServiceAccount } from "./zitadel-service-account";

type Command = {
	summary: string;
	/** What an error message starts with; empty when the command words its own. */
	prefix: string;
	run: (argv: string[]) => number | undefined | Promise<number | undefined>;
};

const TABLE: Record<CommandName, Command> = {
	setup: {
		summary: "Create the .env files, the ZITADEL applications, keys, roles, and local test users",
		prefix: "setup",
		run: (argv) => setup(argv),
	},
	"check-ports": {
		summary: "Check that no two services share a port",
		prefix: "",
		run: checkPortsCommand,
	},
	"project:rename": {
		summary: "Give the project its own name",
		prefix: "project:rename",
		run: renameCommand,
	},
	"project:update": {
		summary: "Bring in the changes of Vern's main branch",
		prefix: "project:update",
		run: updateCommand,
	},
	"project:stack": {
		summary: "Choose how each environment runs",
		prefix: "project:stack",
		run: stackCommand,
	},
	"project:doctor": {
		summary: "Check the tools, configuration, roles, and ports",
		prefix: "",
		run: doctorCommand,
	},
	"zitadel:app": {
		summary: "Create or update an app's ZITADEL application",
		prefix: "",
		run: (argv) => zitadelApp(argv),
	},
	"zitadel:service-account": {
		summary: "Create a service user that manages users",
		prefix: "zitadel:service-account",
		run: (argv) => zitadelServiceAccount(argv),
	},
};

function usage(): string {
	const width = Math.max(...COMMANDS.map((name) => name.length));
	return [
		`Usage: ${CLI_BIN} <command> [options]`,
		"",
		"A project runs each command as the script of the same name: `bun run setup`.",
		"",
		...COMMANDS.map((name) => `  ${name.padEnd(width)}  ${TABLE[name].summary}`),
		"",
		`\`${CLI_BIN} <command> --help\` says what a command takes.`,
	].join("\n");
}

const [name, ...argv] = process.argv.slice(2);
if (!name || name === "--help" || name === "-h") {
	console.log(usage());
} else if (!(name in TABLE)) {
	console.error(`${CLI_BIN}: unknown command "${name}".\n\n${usage()}`);
	process.exitCode = 1;
} else {
	const command = TABLE[name as CommandName];
	runCommand(command.prefix, () => command.run(argv));
}
