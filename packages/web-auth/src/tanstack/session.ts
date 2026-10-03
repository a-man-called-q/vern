import {
	deleteCookie,
	getCookie,
	useSession as getSessionManager,
	setCookie,
} from "@tanstack/react-start/server";
import { getSessionSecret } from "../core/config";
import {
	APP_SESSION_MAX_AGE,
	type AuthTransaction,
	createSessionRecords,
	getCookieOptions,
	isSessionId,
	newSessionId,
	newSessionRecord,
	type SessionStore,
	TRANSACTION_MAX_AGE,
} from "../core/session-record";

/**
 * The sessions of the app `appId`, with their cookies the TanStack Start way.
 * The record they point at, and the sign-in flow that uses them, are in
 * core/session-record.ts and core/auth-flow.ts.
 *
 * Cookies are shared across ports on localhost, so they are named per app to
 * keep several apps from clearing each other's sessions.
 */
export function createTanStackSessionStore(appId: string): SessionStore {
	const sessionCookie = `${appId}-session`;
	const transactionCookie = `${appId}-auth-transaction`;
	const records = createSessionRecords(`${appId}:session:`);

	function getSessionIdFromCookie() {
		const id = getCookie(sessionCookie);
		return isSessionId(id) ? id : null;
	}

	function clearSessionCookie() {
		const { secure, sameSite, path } = getCookieOptions();
		deleteCookie(sessionCookie, { secure, sameSite, path });
	}

	return {
		async create(data) {
			const id = newSessionId();
			await records.create(id, newSessionRecord(data));
			setCookie(sessionCookie, id, {
				...getCookieOptions(),
				maxAge: APP_SESSION_MAX_AGE,
			});
		},

		// A cookie that names no session is left alone: it reads as signed out,
		// and signing in replaces it.
		async read() {
			const id = getSessionIdFromCookie();
			if (!id) return null;

			const data = await records.read(id);
			return data ? { id, data } : null;
		},

		async update(id, data) {
			if (!(await records.write(id, data))) clearSessionCookie();
		},

		async remove() {
			const id = getSessionIdFromCookie();
			clearSessionCookie();
			if (!id) return null;

			return records.take(id);
		},

		/** Sealed, short-lived cookie holding the PKCE state between redirects. */
		async transaction() {
			const session = await getSessionManager<AuthTransaction>({
				name: transactionCookie,
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
		},
	};
}
