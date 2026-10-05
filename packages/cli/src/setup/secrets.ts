import { randomBytes } from "node:crypto";
import type { SecretKind } from "./context";

export function randomSecret(kind: SecretKind, bytes: number): string {
	const value = randomBytes(bytes);
	if (kind === "hex") return value.toString("hex");
	if (kind === "base64") return value.toString("base64");
	// ZITADEL's default password policy wants upper and lower case, a digit, and a symbol.
	return `${value.toString("base64url")}Aa1!`;
}
