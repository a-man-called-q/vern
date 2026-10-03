import { createApiClient } from "./auth.server";

// Calls to the APIs as the signed-in user, from server code only. `path` is a
// relative path, never a caller's URL. A call throws
// `AuthenticationRequiredError` when the session is gone: send the user to
// sign in (`redirectToLogin` of ./auth.server).

/**
 * `createApiClient("BILLING_API_URL")` is the client of the API whose base URL
 * is in that variable. An app that calls a second API makes one client per API,
 * in the server module of that API. List the APIs in `API_APPS` in the app's
 * `.env.example` and `bun run setup` fills the variables in.
 */
export { createApiClient };

/** The API in `API_BASE_URL`: the one `bun run setup` wires a web app to. */
export const fetchAuthenticatedApi = createApiClient("API_BASE_URL");
