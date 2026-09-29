/**
 * Caches one async value for `ttlMs`. Concurrent callers share a single load,
 * and if a refresh fails the last good value keeps being served, so a brief
 * identity-provider outage does not take sign-in down with it.
 */
export function createTtlCache<T>(
	load: () => Promise<T>,
	ttlMs: number,
	now: () => number = Date.now,
): () => Promise<T> {
	let current: { value: T; expiresAt: number } | undefined;
	let inflight: Promise<T> | undefined;

	return async () => {
		if (current && current.expiresAt > now()) return current.value;

		inflight ??= load()
			.then((value) => {
				current = { value, expiresAt: now() + ttlMs };
				return value;
			})
			.finally(() => {
				inflight = undefined;
			});

		try {
			return await inflight;
		} catch (error) {
			if (current) return current.value;
			throw error;
		}
	};
}
