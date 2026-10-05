# @vern/cli

The commands of a project made from [Vern](https://github.com/a-man-called-q/vern):
setup, the ZITADEL provisioning, the port check, doctor, rename, update, and the
choice of how each environment runs. A project installs this package and runs it
through the scripts of its root `package.json`:

| Script | Runs |
| --- | --- |
| `bun run setup` | `vern setup` |
| `bun run project:rename` | `vern project:rename` |
| `bun run project:update` | `bunx @vern/cli@latest project:update` |
| `bun run project:stack` | `vern project:stack` |
| `bun run project:doctor` | `vern project:doctor` |
| `bun run zitadel:app` | `vern zitadel:app` |
| `bun run zitadel:service-account` | `vern zitadel:service-account` |
| `moon run workspace:check-ports` | `vern check-ports` |

`vern --help` lists the commands and `vern <command> --help` says what one
takes. Vern's README describes each of them. A command works on the project it
is run in: the nearest folder, going up, that holds `.moon/workspace.yml`.

The package is TypeScript that [Bun](https://bun.sh) runs as it is, with no
build step and no dependencies. It needs Bun 1.4 or later.

## In Vern's repository

The source is `packages/cli`, a member of the Bun workspace, so the root
`package.json` gets this folder for the range it asks for and every command
runs the code of the checkout. A project has no such folder: a rename removes
it (`--keep-cli` keeps it, to try a rename in a checkout of Vern), an update
never brings it, and the same range resolves from npm.

```sh
moon run cli:test    # or: bun test packages/cli
```

`src/` has `bin.ts` and one file per command at the top, and the code they run
in groups that depend one way (`structure.test.ts` holds the rule):

```text
commands → setup | project | doctor → zitadel → lib
```

A new command gets its name in `src/lib/commands.ts`, its entry in `src/bin.ts`,
and a script in the root `package.json`. A rename keeps the text `vern <command>`
for the names in that list, and `@vern/cli`, as they are.

## Releases

A project updates to Vern's `main` and installs the CLI from npm, so a change
here reaches it only as a new version:

1. Raise `version` in `package.json` in the pull request that changes `src/`
   (the `CLI` workflow fails without it). Raise the range of `@vern/cli` in the
   root `package.json` too when the new version is outside it, which for a `0.x`
   version is every minor.
2. Merge. The `CLI` workflow publishes a version npm does not have yet, with
   npm's trusted publishing: no token is stored.
3. Tag a release of the template only after the version is on npm. A project
   created from the tag resolves the range at once.
