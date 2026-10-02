import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/run";

/**
 * A local certificate authority in `dir` (`ca.pem`) and one certificate
 * (`cert.pem`, `key.pem`) for `names`, for a rehearsal on this machine.
 * `shared` lets the containers that mount the folder read it as another user.
 * Returns false when the certificate was already there.
 */
export function ensureLocalCertificates(dir: string, names: string[], options: { shared?: boolean } = {}): boolean {
	if (existsSync(join(dir, "cert.pem"))) return false;
	mkdirSync(dir, { recursive: true, mode: options.shared ? 0o755 : 0o700 });
	const openssl = (...args: string[]) => run("openssl", args, { cwd: dir });
	openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365", "-subj", "/CN=Vern local CA",
		"-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
		"-keyout", "ca-key.pem", "-out", "ca.pem");
	openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${names[0]}`, "-keyout", "key.pem", "-out", "cert.csr");
	writeFileSync(
		join(dir, "cert.ext"),
		`subjectAltName=${names.map((name) => `DNS:${name}`).join(",")}\nextendedKeyUsage=serverAuth\n`,
	);
	openssl("x509", "-req", "-in", "cert.csr", "-CA", "ca.pem", "-CAkey", "ca-key.pem", "-CAcreateserial", "-days", "365",
		"-extfile", "cert.ext", "-out", "cert.pem");
	for (const file of ["cert.csr", "cert.ext", "ca.srl"]) rmSync(join(dir, file), { force: true });
	if (options.shared) for (const file of ["ca.pem", "cert.pem", "key.pem"]) chmodSync(join(dir, file), 0o644);
	return true;
}

/** fetch that trusts the local certificate authority (Bun's `tls.ca`). */
export function trustingFetch(caFile: string): typeof fetch {
	const ca = readFileSync(caFile, "utf8");
	return ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, tls: { ca } } as RequestInit)) as typeof fetch;
}
