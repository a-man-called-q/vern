/** The signed-in user as the app session holds it. */
export type AuthUser = {
	sub: string;
	name?: string;
	email?: string;
};

/**
 * A call to one API as the signed-in user. `path` is a relative path that
 * begins with a single slash, never a caller's URL.
 */
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
