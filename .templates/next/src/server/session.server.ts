import "server-only";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { APP_ID } from "../lib/site";
import { getSessionSecret } from "./config.server";
import {
	APP_SESSION_MAX_AGE,
	type AuthTransaction,
	type AuthTransactionStore,
	createSessionRecords,
	getCookieOptions,
	isSessionId,
	type LoadedAuthSession,
	newSessionId,
	newSessionRecord,
	type StoredAuthSession,
	TRANSACTION_MAX_AGE,
} from "./session-record.server";

// The session's cookies, the Next.js way. The record they point at, and the
// sign-in flow that uses them, are in session-record.server.ts and
// auth-flow.server.ts.

export type { LoadedAuthSession, StoredAuthSession };

// Cookies are shared across ports on localhost, so name them per app to keep
// several generated apps from clearing each other's sessions.
const APP_SESSION_COOKIE = `${APP_ID}-session`;
const AUTH_TRANSACTION_COOKIE = `${APP_ID}-auth-transaction`;
const records = createSessionRecords(`${APP_ID}:session:`);

async function getSessionIdFromCookie() {
	const id = (await cookies()).get(APP_SESSION_COOKIE)?.value;
	return isSessionId(id) ? id : null;
}

async function clearAppSessionCookie() {
	try {
		(await cookies()).delete({
			name: APP_SESSION_COOKIE,
			...getCookieOptions(),
		});
	} catch {
		// Server Components cannot modify cookies. The Redis record is removed
		// separately, so a leftover handle simply reads as signed out.
	}
}

/** Route Handlers and Server Actions only: this sets the session cookie. */
export async function createAppSession(
	data: Omit<StoredAuthSession, "sessionExpiresAt" | "version">,
) {
	const id = newSessionId();
	await records.create(id, newSessionRecord(data));
	(await cookies()).set(APP_SESSION_COOKIE, id, {
		...getCookieOptions(),
		maxAge: APP_SESSION_MAX_AGE,
	});
}

/** Safe in Server Components: it never modifies cookies. */
export async function readAppSession(): Promise<LoadedAuthSession | null> {
	const id = await getSessionIdFromCookie();
	if (!id) return null;

	const data = await records.read(id);
	return data ? { id, data } : null;
}

export async function updateAppSession(id: string, data: StoredAuthSession) {
	if (!(await records.write(id, data))) await clearAppSessionCookie();
}

export async function deleteAppSession(): Promise<StoredAuthSession | null> {
	const id = await getSessionIdFromCookie();
	await clearAppSessionCookie();
	if (!id) return null;

	return records.take(id);
}

/** Sealed, short-lived cookie holding the PKCE state between redirects. */
export async function getAuthTransaction(): Promise<AuthTransactionStore> {
	const session = await getIronSession<AuthTransaction>(await cookies(), {
		cookieName: AUTH_TRANSACTION_COOKIE,
		password: getSessionSecret(),
		ttl: TRANSACTION_MAX_AGE,
		cookieOptions: getCookieOptions(),
	});
	return {
		get data() {
			const { flow, state, nonce, codeVerifier } = session;
			return { flow, state, nonce, codeVerifier };
		},
		async update(values) {
			Object.assign(session, values);
			await session.save();
		},
		async clear() {
			session.destroy();
		},
	};
}
