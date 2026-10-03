import assert from "node:assert/strict";
import { test } from "node:test";
import {
	APP_SESSION_MAX_AGE,
	getSessionAgeMs,
	isSessionId,
	newSessionId,
	newSessionRecord,
	parseStoredSession,
} from "./session-record";

const fields = {
	user: { sub: "user-1", name: "Ada" },
	accessToken: "access",
	refreshToken: "refresh",
	accessTokenExpiresAt: 1_000,
};

test("a new record lasts the maximum age and reads back", () => {
	const record = newSessionRecord(fields, 0);
	assert.equal(record.sessionExpiresAt, APP_SESSION_MAX_AGE * 1000);
	assert.deepEqual(parseStoredSession(JSON.stringify(record)), record);
	assert.equal(getSessionAgeMs(record, 5_000), 5_000);
});

test("a record of another shape or version is not read", () => {
	const record = newSessionRecord(fields, 0);
	for (const value of [
		null,
		"not json",
		JSON.stringify({ ...record, version: 0 }),
		JSON.stringify({ ...record, user: { name: "no sub" } }),
		JSON.stringify({ ...record, refreshToken: 42 }),
		JSON.stringify({ ...record, idToken: 42 }),
	]) {
		assert.equal(parseStoredSession(value), null, String(value));
	}
});

test("only IDs shaped like the ones it makes are session IDs", () => {
	assert.equal(isSessionId(newSessionId()), true);
	for (const value of [undefined, null, "", "short", `${newSessionId()}x`]) {
		assert.equal(isSessionId(value), false, String(value));
	}
});
