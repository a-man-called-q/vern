import { resolve } from "node:path";

/** The repository root: every command works from here unless told otherwise. */
export const ROOT = resolve(import.meta.dir, "../..");
