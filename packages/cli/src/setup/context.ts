import type { AppKind } from "../lib/projects";

export type Log = (message: string) => void;

export type SecretKind = "hex" | "base64" | "password";

/** What a test swaps out: the machine, the network, Docker, and time. */
export type SetupDeps = {
	root?: string;
	env?: Record<string, string | undefined>;
	fetcher?: typeof fetch;
	log?: Log;
	startAuthStack?: (root: string) => void;
	runCompose?: (root: string, args: string[]) => void;
	readStackToken?: (root: string, compose: string[]) => string | undefined;
	sleep?: (ms: number) => Promise<void>;
	issuerTimeoutMs?: number;
	randomSecret?: (kind: SecretKind, bytes: number) => string;
	runKubectl?: (root: string, args: string[]) => void;
	readKubeToken?: (root: string, namespace: string) => string | undefined;
	generateAppManifests?: (root: string, app: { name: string; path: string; kind: AppKind; database: boolean; events: boolean }) => void;
};
