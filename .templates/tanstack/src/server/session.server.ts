import { randomBytes } from "node:crypto";
import { env } from "node:process";
import {
	deleteCookie,
	getCookie,
	useSession as getSessionManager,
	setCookie,
} from "@tanstack/react-start/server";
import { createClient } from "redis";
import type { AuthUser } from "../types/auth";

export type StoredAuthSession = {
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

const APP_SESSION_COOKIE = "app-session";
const REDIS_KEY_PREFIX = "tanstack:session:";
const APP_SESSION_MAX_AGE = 8 * 60 * 60;
const TRANSACTION_MAX_AGE = 10 * 60;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type RedisClient = ReturnType<typeof createClient>;
let redisClientPromise: Promise<RedisClient> | undefined;

function getSessionSecret() {
	const secret = env.SESSION_SECRET;

	if (!secret || secret.length < 32) {
		throw new Error("SESSION_SECRET must contain at least 32 characters");
	}

	return secret;
}

function getCookieOptions(maxAge: number) {
	return {
		httpOnly: true,
		secure: env.NODE_ENV === "production",
		sameSite: "lax" as const,
		path: "/",
		maxAge,
	};
}

function getRedisClient() {
	if (!redisClientPromise) {
		const url = env.REDIS_URL;
		if (!url) throw new Error("REDIS_URL is required");

		const client = createClient({ url });
		// Keep connection details and Redis command metadata out of application logs.
		client.on("error", () => undefined);
		redisClientPromise = client
			.connect()
			.then(() => client)
			.catch((error) => {
				redisClientPromise = undefined;
				throw error;
			});
	}

	return redisClientPromise;
}

function getSessionIdFromCookie() {
	const id = getCookie(APP_SESSION_COOKIE);
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

function clearAppSessionCookie() {
	deleteCookie(APP_SESSION_COOKIE, {
		secure: env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
	});
}

async function writeAppSession(id: string, data: StoredAuthSession) {
	const ttl = Math.floor((data.sessionExpiresAt - Date.now()) / 1000);
	if (ttl <= 0) {
		const client = await getRedisClient();
		await client.del(getRedisKey(id));
		clearAppSessionCookie();
		return;
	}

	const client = await getRedisClient();
	await client.set(getRedisKey(id), JSON.stringify(data), { EX: ttl });
}

export async function createAppSession(
	data: Omit<StoredAuthSession, "sessionExpiresAt">,
) {
	const id = randomBytes(32).toString("base64url");
	const session: StoredAuthSession = {
		...data,
		sessionExpiresAt: Date.now() + APP_SESSION_MAX_AGE * 1000,
	};
	const client = await getRedisClient();
	await client.set(getRedisKey(id), JSON.stringify(session), {
		EX: APP_SESSION_MAX_AGE,
	});
	setCookie(APP_SESSION_COOKIE, id, getCookieOptions(APP_SESSION_MAX_AGE));
}

export async function readAppSession(): Promise<LoadedAuthSession | null> {
	const id = getSessionIdFromCookie();
	if (!id) {
		clearAppSessionCookie();
		return null;
	}

	const client = await getRedisClient();
	const session = parseStoredSession(await client.get(getRedisKey(id)));
	if (!session || session.sessionExpiresAt <= Date.now()) {
		await client.del(getRedisKey(id));
		clearAppSessionCookie();
		return null;
	}

	return { id, data: session };
}

export async function updateAppSession(id: string, data: StoredAuthSession) {
	await writeAppSession(id, data);
}

export async function deleteAppSession(): Promise<StoredAuthSession | null> {
	const id = getSessionIdFromCookie();
	clearAppSessionCookie();
	if (!id) return null;

	const client = await getRedisClient();
	const session = parseStoredSession(await client.get(getRedisKey(id)));
	await client.del(getRedisKey(id));
	return session;
}

export function getAuthTransactionSession() {
	return getSessionManager<AuthTransaction>({
		name: "auth-transaction",
		password: getSessionSecret(),
		maxAge: TRANSACTION_MAX_AGE,
		sessionHeader: false,
		cookie: getCookieOptions(TRANSACTION_MAX_AGE),
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
