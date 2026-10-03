import "server-only";
import { createWebAuth } from "@vern/web-auth/next";
import { APP_ID } from "@/lib/site";

// Sign-in for this app. The flow, the session, and the API calls are in
// @vern/web-auth, which every web app shares; this module is the one place that
// binds them to the app.
export const auth = createWebAuth({ appId: APP_ID });

export const { createApiClient, getCurrentUser, redirectToLogin, requireUser } =
	auth;
export { AuthenticationRequiredError } from "@vern/web-auth/next";
