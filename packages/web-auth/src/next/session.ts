import "server-only";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
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
 * The sessions of the app `appId`, with their cookies the Next.js way. The
 * record they point at, and the sign-in flow that uses them, are in
 * core/session-record.ts and core/auth-flow.ts.
 *
 * Cookies are shared across ports on localhost, so they are named per app to
 * keep several apps from clearing each other's sessions.
 */
export function createNextSessionStore(appId: string): SessionStore {
	const sessionCookie = `${appId}-session`;
	const transactionCookie = `${appId}-auth-transaction`;
	const records = createSessionRecords(`${appId}:session:`);

	async function getSessionIdFromCookie() {
		const id = (await cookies()).get(sessionCookie)?.value;
		return isSessionId(id) ? id : null;
	}

	async function clearSessionCookie() {
		try {
			(await cookies()).delete({
				name: sessionCookie,
				...getCookieOptions(),
			});
		} catch {
			// Server Components cannot modify cookies. The Redis record is removed
			// separately, so a leftover handle simply reads as signed out.
		}
	}

	return {
		/** Route Handlers and Server Actions only: this sets the session cookie. */
		async create(data) {
			const id = newSessionId();
			await records.create(id, newSessionRecord(data));
			(await cookies()).set(sessionCookie, id, {
				...getCookieOptions(),
				maxAge: APP_SESSION_MAX_AGE,
			});
		},

		/** Safe in Server Components: it never modifies cookies. */
		async read() {
			const id = await getSessionIdFromCookie();
			if (!id) return null;

			const data = await records.read(id);
			return data ? { id, data } : null;
		},

		async update(id, data) {
			if (!(await records.write(id, data))) await clearSessionCookie();
		},

		async remove() {
			const id = await getSessionIdFromCookie();
			await clearSessionCookie();
			if (!id) return null;

			return records.take(id);
		},

		/** Sealed, short-lived cookie holding the PKCE state between redirects. */
		async transaction() {
			const session = await getIronSession<AuthTransaction>(await cookies(), {
				cookieName: transactionCookie,
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
		},
	};
}
