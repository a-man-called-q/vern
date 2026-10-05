/** The package the CLI is published as, and the command it installs. */
export const CLI_PACKAGE = "@tsanyqudsi/vern";
export const CLI_BIN = "vern";

/**
 * Every command, by the name of the script in the project's package.json that
 * runs it: `bun run setup` is `vern setup`.
 */
export const COMMANDS = [
	"setup",
	"check-ports",
	"project:rename",
	"project:update",
	"project:stack",
	"project:doctor",
	"zitadel:app",
	"zitadel:service-account",
] as const;

export type CommandName = (typeof COMMANDS)[number];
