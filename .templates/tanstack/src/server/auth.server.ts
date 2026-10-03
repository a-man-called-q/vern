import { createWebAuth } from "@vern/web-auth/tanstack";
import { APP_ID } from "../lib/site";

// Sign-in for this app. The flow, the session, and the API calls are in
// @vern/web-auth, which every web app shares; this module is the one place that
// binds them to the app. Server code only: browser code reaches it through the
// server functions in ./auth.ts.
export const auth = createWebAuth({ appId: APP_ID });

export const { createApiClient, getCurrentUser, redirectToLogin, requireUser } =
	auth;
export { AuthenticationRequiredError } from "@vern/web-auth/tanstack";
