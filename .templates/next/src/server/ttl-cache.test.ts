import assert from "node:assert/strict";
import { test } from "node:test";
import { createTtlCache } from "./ttl-cache";

test("loads once within the ttl and again after it", async () => {
	let clock = 0;
	let loads = 0;
	const get = createTtlCache(
		async () => ++loads,
		1_000,
		() => clock,
	);

	assert.equal(await get(), 1);
	clock = 999;
	assert.equal(await get(), 1);
	clock = 1_000;
	assert.equal(await get(), 2);
	assert.equal(loads, 2);
});

test("concurrent callers share one load", async () => {
	let loads = 0;
	const get = createTtlCache(async () => {
		loads += 1;
		await new Promise((resolve) => setTimeout(resolve, 10));
		return "value";
	}, 1_000);

	const results = await Promise.all([get(), get(), get()]);
	assert.deepEqual(results, ["value", "value", "value"]);
	assert.equal(loads, 1);
});

test("a failed first load is not cached", async () => {
	let attempts = 0;
	const get = createTtlCache(async () => {
		attempts += 1;
		if (attempts === 1) throw new Error("issuer unavailable");
		return "recovered";
	}, 1_000);

	await assert.rejects(get(), /issuer unavailable/);
	assert.equal(await get(), "recovered");
});

test("serves the last good value when a refresh fails", async () => {
	let clock = 0;
	let attempts = 0;
	const get = createTtlCache(
		async () => {
			attempts += 1;
			if (attempts === 2) throw new Error("issuer unavailable");
			return `config-${attempts}`;
		},
		1_000,
		() => clock,
	);

	assert.equal(await get(), "config-1");
	clock = 5_000;
	assert.equal(await get(), "config-1");
	assert.equal(await get(), "config-3");
});
