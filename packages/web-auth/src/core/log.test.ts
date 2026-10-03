import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError, sanitizeForLog } from "./log";

test("describes an error with its stable fields only", () => {
	const error = Object.assign(new Error("server responded with an error"), {
		name: "ResponseBodyError",
		code: "OAUTH_RESPONSE_BODY_ERROR",
		error: "invalid_grant",
		error_description: "refresh token is invalid",
		status: 400,
		cause: { access_token: "secret-token" },
		body: { refresh_token: "secret-refresh" },
	});

	const text = describeError(error);
	assert.match(text, /^ResponseBodyError: server responded with an error/);
	assert.match(text, /code=OAUTH_RESPONSE_BODY_ERROR/);
	assert.match(text, /error=invalid_grant/);
	assert.match(text, /status=400/);
	assert.doesNotMatch(text, /secret/);
});

test("strips control characters so values cannot forge log lines", () => {
	assert.equal(
		sanitizeForLog("bad\nfake line\r\u0000end"),
		"bad fake line  end",
	);
});

test("bounds the length of logged values", () => {
	const text = sanitizeForLog("x".repeat(500));
	assert.equal(text.length, 203);
	assert.ok(text.endsWith("..."));
});

test("describes non-error values", () => {
	assert.equal(describeError("HTTP 503"), "HTTP 503");
	assert.equal(describeError(undefined), "");
});
