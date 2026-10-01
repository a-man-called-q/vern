import "server-only";
import { randomBytes } from "node:crypto";
import { env } from "node:process";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { createClient } from "redis";
import { APP_ID } from "../lib/site";
import type { AuthUser } from "../types/auth";

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

export type AuthTransaction = {
	flow?: "login" | "logout";
	state?: string;
	nonce?: string;
	codeVerifier?: string;
};

// Cookies are shared across ports on localhost, so name them per app to keep
// several generated apps from clearing each other's sessions.
const APP_SESSION_COOKIE = `${APP_ID}-session`;
const AUTH_TRANSACTION_COOKIE = `${APP_ID}-auth-transaction`;
const REDIS_KEY_PREFIX = `${APP_ID}:session:`;
// Redis records outlive deploys. Bump this whenever the stored shape changes:
// older records are then rejected and removed, and users simply sign in again.
const SESSION_VERSION = 1;
const APP_SESSION_MAX_AGE = 8 * 60 * 60;
const TRANSACTION_MAX_AGE = 10 * 60;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type RedisClient = ReturnType<typeof createClient>;
// Cached on globalThis so dev-server module reloads reuse one connection.
const globalForRedis = globalThis as typeof globalThis & {
	appRedisClient?: Promise<RedisClient>;
};

function getSessionSecret() {
	const secret = env.SESSION_SECRET;

	if (!secret || secret.length < 32) {
		throw new Error("SESSION_SECRET must contain at least 32 characters");
	}

	return secret;
}

function getBaseCookieOptions() {
	return {
		httpOnly: true,
		secure: env.NODE_ENV === "production",
		sameSite: "lax" as const,
		path: "/",
	};
}

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

async function getSessionIdFromCookie() {
	const id = (await cookies()).get(APP_SESSION_COOKIE)?.value;
	return id && SESSION_ID_PATTERN.test(id) ? id : null;
}

function getRedisKey(id: string) {
	return `${REDIS_KEY_PREFIX}${id}`;
}

function parseStoredSession(value: string | null): StoredAuthSession | null {
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

async function clearAppSessionCookie() {
	try {
		(await cookies()).delete({
			name: APP_SESSION_COOKIE,
			...getBaseCookieOptions(),
		});
	} catch {
		// Server Components cannot modify cookies. The Redis record is removed
		// separately, so a leftover handle simply reads as signed out.
	}
}

async function writeAppSession(id: string, data: StoredAuthSession) {
	const client = await getRedisClient();
	const ttl = Math.floor((data.sessionExpiresAt - Date.now()) / 1000);
	if (ttl <= 0) {
		await client.del(getRedisKey(id));
		await clearAppSessionCookie();
		return;
	}

	await client.set(getRedisKey(id), JSON.stringify(data), { EX: ttl });
}

/** Route Handlers and Server Actions only: this sets the session cookie. */
export async function createAppSession(
	data: Omit<StoredAuthSession, "sessionExpiresAt" | "version">,
) {
	const id = randomBytes(32).toString("base64url");
	const session: StoredAuthSession = {
		...data,
		version: SESSION_VERSION,
		sessionExpiresAt: Date.now() + APP_SESSION_MAX_AGE * 1000,
	};
	const client = await getRedisClient();
	await client.set(getRedisKey(id), JSON.stringify(session), {
		EX: APP_SESSION_MAX_AGE,
	});
	(await cookies()).set(APP_SESSION_COOKIE, id, {
		...getBaseCookieOptions(),
		maxAge: APP_SESSION_MAX_AGE,
	});
}

/** Safe in Server Components: it never modifies cookies. */
export async function readAppSession(): Promise<LoadedAuthSession | null> {
	const id = await getSessionIdFromCookie();
	if (!id) return null;

	const client = await getRedisClient();
	const session = parseStoredSession(await client.get(getRedisKey(id)));
	if (!session || session.sessionExpiresAt <= Date.now()) {
		await client.del(getRedisKey(id));
		return null;
	}

	return { id, data: session };
}

/** How long ago the session was created (`sessionExpiresAt` is creation + max age). */
export function getSessionAgeMs(data: StoredAuthSession) {
	return Date.now() - (data.sessionExpiresAt - APP_SESSION_MAX_AGE * 1000);
}

export async function updateAppSession(id: string, data: StoredAuthSession) {
	await writeAppSession(id, data);
}

export async function deleteAppSession(): Promise<StoredAuthSession | null> {
	const id = await getSessionIdFromCookie();
	await clearAppSessionCookie();
	if (!id) return null;

	const client = await getRedisClient();
	const session = parseStoredSession(await client.get(getRedisKey(id)));
	await client.del(getRedisKey(id));
	return session;
}

/** Sealed, short-lived cookie holding the PKCE state between redirects. */
export async function getAuthTransactionSession() {
	return getIronSession<AuthTransaction>(await cookies(), {
		cookieName: AUTH_TRANSACTION_COOKIE,
		password: getSessionSecret(),
		ttl: TRANSACTION_MAX_AGE,
		cookieOptions: getBaseCookieOptions(),
	});
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
