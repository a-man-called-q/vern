// Sign-in for the web apps, whatever the framework: the OIDC flow, the session
// record in Redis, and the server-side call to an API with the user's token.
// An app does not import this: `@vern/web-auth/next` and
// `@vern/web-auth/tanstack` bind it to a framework and give `createWebAuth`.

export {
	type ApiSession,
	createApiClientFactory,
	createAuthenticatedApiFetcher,
} from "./core/api";
export { AuthenticationRequiredError } from "./core/auth-error";
export { type AuthFlow, createAuthFlow } from "./core/auth-flow";
export { logAuthFailure, logAuthWarning } from "./core/log";
export type {
	AuthTransactionStore,
	LoadedAuthSession,
	SessionStore,
	StoredAuthSession,
} from "./core/session-record";
export type { ApiFetch, AuthUser } from "./core/types";
