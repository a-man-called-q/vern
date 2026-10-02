import { randomBytes } from "node:crypto";
import { env } from "node:process";
import { createClient } from "redis";
import type { AuthUser } from "../types/auth";

// The session record and where it lives, the same whatever the framework: the
// browser holds only a random ID in a cookie, and the tokens sit in Redis under
// that ID. src/server/session.server.ts adds the cookies, which each framework
// reads and writes its own way.

export type StoredAuthSession = {
	version: number;
	user: AuthUser;
	accessToken: string;
	refreshToken: string;
	idToken?: string;
	accessTokenExpiresAt: number;
	sessionExpiresAt: number;
};

export type LoadedAuthSession = {
	id: string;
	data: StoredAuthSession;
};

/** The PKCE state between the redirects of a sign-in or a sign-out. */
export type AuthTransaction = {
	flow?: "login" | "logout";
	state?: string;
	nonce?: string;
	codeVerifier?: string;
};

/** The sealed, short-lived cookie that holds an `AuthTransaction`. */
export type AuthTransactionStore = {
	readonly data: AuthTransaction;
	/** Sets these values, keeping the others. */
	update(values: AuthTransaction): Promise<void>;
	clear(): Promise<void>;
};

// Redis records outlive deploys. Bump this whenever the stored shape changes:
// older records are then rejected and removed, and users simply sign in again.
const SESSION_VERSION = 1;
export const APP_SESSION_MAX_AGE = 8 * 60 * 60;
export const TRANSACTION_MAX_AGE = 10 * 60;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The attributes of every cookie the app sets. */
export function getCookieOptions() {
	return {
		httpOnly: true,
		secure: env.NODE_ENV === "production",
		sameSite: "lax" as const,
		path: "/",
	};
}

export function newSessionId() {
	return randomBytes(32).toString("base64url");
}

/** A session ID as `newSessionId` makes them; anything else in the cookie is ignored. */
export function isSessionId(id: string | null | undefined): id is string {
	return Boolean(id && SESSION_ID_PATTERN.test(id));
}

export function isAuthUser(value: unknown): value is AuthUser {
	if (!value || typeof value !== "object") return false;

	const user = value as Record<string, unknown>;
	return (
		typeof user.sub === "string" &&
		(user.name === undefined || typeof user.name === "string") &&
		(user.email === undefined || typeof user.email === "string")
	);
}

export function parseStoredSession(
	value: string | null,
): StoredAuthSession | null {
	if (!value) return null;

	try {
		const session: unknown = JSON.parse(value);
		if (!session || typeof session !== "object") return null;

		const record = session as Record<string, unknown>;
		if (
			record.version !== SESSION_VERSION ||
			!isAuthUser(record.user) ||
			typeof record.accessToken !== "string" ||
			typeof record.refreshToken !== "string" ||
			typeof record.accessTokenExpiresAt !== "number" ||
			typeof record.sessionExpiresAt !== "number" ||
			(record.idToken !== undefined && typeof record.idToken !== "string")
		) {
			return null;
		}

		return {
			version: SESSION_VERSION,
			user: record.user,
			accessToken: record.accessToken,
			refreshToken: record.refreshToken,
			...(typeof record.idToken === "string"
				? { idToken: record.idToken }
				: {}),
			accessTokenExpiresAt: record.accessTokenExpiresAt,
			sessionExpiresAt: record.sessionExpiresAt,
		};
	} catch {
		return null;
	}
}

/** A new session's record: it lasts `APP_SESSION_MAX_AGE` from now. */
export function newSessionRecord(
	data: Omit<StoredAuthSession, "sessionExpiresAt" | "version">,
	now = Date.now(),
): StoredAuthSession {
	return {
		...data,
		version: SESSION_VERSION,
		sessionExpiresAt: now + APP_SESSION_MAX_AGE * 1000,
	};
}

/** How long ago the session was created (`sessionExpiresAt` is creation + max age). */
export function getSessionAgeMs(data: StoredAuthSession, now = Date.now()) {
	return now - (data.sessionExpiresAt - APP_SESSION_MAX_AGE * 1000);
}

type RedisClient = ReturnType<typeof createClient>;
// Cached on globalThis so dev-server module reloads reuse one connection.
const globalForRedis = globalThis as typeof globalThis & {
	appRedisClient?: Promise<RedisClient>;
};

function getRedisClient() {
	if (!globalForRedis.appRedisClient) {
		const url = env.REDIS_URL;
		if (!url) throw new Error("REDIS_URL is required");

		const client = createClient({ url });
		// Keep connection details and Redis command metadata out of application logs.
		client.on("error", () => undefined);
		globalForRedis.appRedisClient = client
			.connect()
			.then(() => client)
			.catch((error) => {
				globalForRedis.appRedisClient = undefined;
				throw error;
			});
	}

	return globalForRedis.appRedisClient;
}

/** The Redis records of one app's sessions, each under `<keyPrefix><id>`. */
export function createSessionRecords(keyPrefix: string) {
	const key = (id: string) => `${keyPrefix}${id}`;

	return {
		async create(id: string, data: StoredAuthSession) {
			const client = await getRedisClient();
			await client.set(key(id), JSON.stringify(data), {
				EX: APP_SESSION_MAX_AGE,
			});
		},

		/** The record, or null after removing one that is unreadable or expired. */
		async read(id: string) {
			const client = await getRedisClient();
			const session = parseStoredSession(await client.get(key(id)));
			if (!session || session.sessionExpiresAt <= Date.now()) {
				await client.del(key(id));
				return null;
			}
			return session;
		},

		/** Replaces the record; false when the session has expired and was removed instead. */
		async write(id: string, data: StoredAuthSession) {
			const client = await getRedisClient();
			const ttl = Math.floor((data.sessionExpiresAt - Date.now()) / 1000);
			if (ttl <= 0) {
				await client.del(key(id));
				return false;
			}
			await client.set(key(id), JSON.stringify(data), { EX: ttl });
			return true;
		},

		/** Removes the record and returns what it held. */
		async take(id: string) {
			const client = await getRedisClient();
			const session = parseStoredSession(await client.get(key(id)));
			await client.del(key(id));
			return session;
		},
	};
}
