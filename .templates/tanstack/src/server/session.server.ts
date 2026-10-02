import {
	deleteCookie,
	getCookie,
	useSession as getSessionManager,
	setCookie,
} from "@tanstack/react-start/server";
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

// The session's cookies, the TanStack Start way. The record they point at, and
// the sign-in flow that uses them, are in session-record.server.ts and
// auth-flow.server.ts.

export type { LoadedAuthSession, StoredAuthSession };

const APP_SESSION_COOKIE = "app-session";
const records = createSessionRecords("tanstack:session:");

function getSessionIdFromCookie() {
	const id = getCookie(APP_SESSION_COOKIE);
	return isSessionId(id) ? id : null;
}

function clearAppSessionCookie() {
	const { secure, sameSite, path } = getCookieOptions();
	deleteCookie(APP_SESSION_COOKIE, { secure, sameSite, path });
}

export async function createAppSession(
	data: Omit<StoredAuthSession, "sessionExpiresAt" | "version">,
) {
	const id = newSessionId();
	await records.create(id, newSessionRecord(data));
	setCookie(APP_SESSION_COOKIE, id, {
		...getCookieOptions(),
		maxAge: APP_SESSION_MAX_AGE,
	});
}

export async function readAppSession(): Promise<LoadedAuthSession | null> {
	const id = getSessionIdFromCookie();
	if (!id) {
		clearAppSessionCookie();
		return null;
	}

	const data = await records.read(id);
	if (!data) {
		clearAppSessionCookie();
		return null;
	}

	return { id, data };
}

export async function updateAppSession(id: string, data: StoredAuthSession) {
	if (!(await records.write(id, data))) clearAppSessionCookie();
}

export async function deleteAppSession(): Promise<StoredAuthSession | null> {
	const id = getSessionIdFromCookie();
	clearAppSessionCookie();
	if (!id) return null;

	return records.take(id);
}

/** Sealed, short-lived cookie holding the PKCE state between redirects. */
export async function getAuthTransaction(): Promise<AuthTransactionStore> {
	const session = await getSessionManager<AuthTransaction>({
		name: "auth-transaction",
		password: getSessionSecret(),
		maxAge: TRANSACTION_MAX_AGE,
		sessionHeader: false,
		cookie: { ...getCookieOptions(), maxAge: TRANSACTION_MAX_AGE },
	});
	return {
		get data() {
			return session.data;
		},
		async update(values) {
			await session.update(values);
		},
		async clear() {
			await session.clear();
		},
	};
}
