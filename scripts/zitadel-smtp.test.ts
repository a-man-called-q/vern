import { describe, expect, test } from "bun:test";
import { ensureSmtp, readSmtpSettings, type SmtpSettings } from "./zitadel-smtp";

const env = (values: Record<string, string>) => new Map(Object.entries(values));
const FULL = { SMTP_HOST: "smtp.acme.test:587", SMTP_FROM_ADDRESS: "hello@acme.test" };

describe("readSmtpSettings", () => {
	test("nothing set means no mail from this deployment", () => {
		expect(readSmtpSettings(env({}), "deploy/.env", "Vern")).toBeUndefined();
		expect(readSmtpSettings(env({ SMTP_HOST: " ", SMTP_USER: "", SMTP_TLS: "true" }), "deploy/.env", "Vern")).toBeUndefined();
	});

	test("reads the settings, with TLS on and the organization's name as the sender by default", () => {
		expect(readSmtpSettings(env(FULL), "deploy/.env", "Acme Inc")).toEqual({
			host: "smtp.acme.test:587",
			senderAddress: "hello@acme.test",
			senderName: "Acme Inc",
			tls: true,
		});
		expect(
			readSmtpSettings(
				env({ ...FULL, SMTP_FROM_NAME: "Acme", SMTP_USER: "u", SMTP_PASSWORD: "p", SMTP_REPLY_TO: "help@acme.test", SMTP_TLS: "FALSE" }),
				"deploy/.env",
				"Vern",
			),
		).toEqual({
			host: "smtp.acme.test:587",
			user: "u",
			password: "p",
			senderAddress: "hello@acme.test",
			senderName: "Acme",
			tls: false,
			replyTo: "help@acme.test",
		});
	});

	test.each([
		["a setting without the host", { SMTP_FROM_ADDRESS: "a@b.test" }, "SMTP_FROM_ADDRESS set in deploy/.env without SMTP_HOST"],
		["a host without a port", { ...FULL, SMTP_HOST: "smtp.acme.test" }, "SMTP_HOST must be host:port"],
		["a port out of range", { ...FULL, SMTP_HOST: "smtp.acme.test:70000" }, "SMTP_HOST must be host:port"],
		["no sender address", { SMTP_HOST: "smtp.acme.test:587" }, "SMTP_FROM_ADDRESS must be an email address"],
		["a sender that is not an address", { ...FULL, SMTP_FROM_ADDRESS: "hello" }, "SMTP_FROM_ADDRESS must be an email address"],
		["a user without a password", { ...FULL, SMTP_USER: "u" }, "SMTP_USER and SMTP_PASSWORD go together"],
		["a password without a user", { ...FULL, SMTP_PASSWORD: "p" }, "SMTP_USER and SMTP_PASSWORD go together"],
		["a TLS flag that is not a boolean", { ...FULL, SMTP_TLS: "yes" }, 'SMTP_TLS must be true or false in deploy/.env, not "yes"'],
	])("rejects %s", (_name, values, message) => {
		expect(() => readSmtpSettings(env(values), "deploy/.env", "Vern")).toThrow(message);
	});
});

type Config = Record<string, unknown>;

/** A fake of ZITADEL's admin SMTP API. */
function fakeZitadel(configs: Config[] = []) {
	const calls: { method: string; path: string; body: Record<string, any> }[] = [];
	const passwords = new Map<string, string>();
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input)).pathname;
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		calls.push({ method, path, body });
		if (path === "/admin/v1/smtp/_search") return json(configs.length > 0 ? { result: configs } : { details: {} });
		if (path === "/admin/v1/smtp" && method === "POST") {
			const { password, ...rest } = body;
			const config = { id: "new1", state: "SMTP_CONFIG_INACTIVE", ...rest };
			configs.push(config);
			if (password) passwords.set("new1", password);
			return json({ id: "new1" });
		}
		const route = path.match(/^\/admin\/v1\/smtp\/([^/]+)(?:\/(_activate|password))?$/);
		const config = route && configs.find((item) => item.id === route[1]);
		if (route && config) {
			if (route[2] === "_activate") {
				for (const other of configs) other.state = "SMTP_CONFIG_INACTIVE";
				config.state = "SMTP_CONFIG_ACTIVE";
			} else if (route[2] === "password") {
				passwords.set(route[1], body.password);
			} else {
				Object.assign(config, body);
			}
			return json({});
		}
		return json({ message: `unexpected ${method} ${path}` }, 500);
	}) as unknown as typeof fetch;
	return { configs, calls, passwords, api: { issuer: "http://localhost:8081", token: "t", fetcher } };
}

const WANTED: SmtpSettings = {
	host: "smtp.acme.test:587",
	user: "u",
	password: "p1",
	senderAddress: "hello@acme.test",
	senderName: "Acme",
	tls: true,
};
const mutations = (zitadel: ReturnType<typeof fakeZitadel>) => zitadel.calls.filter((call) => !call.path.endsWith("_search"));

describe("ensureSmtp", () => {
	test("creates the configuration with its password and activates it", async () => {
		const zitadel = fakeZitadel();
		expect(await ensureSmtp(zitadel.api, WANTED, { replaceOthers: true })).toEqual({ action: "created", host: "smtp.acme.test:587" });
		expect(zitadel.configs).toHaveLength(1);
		expect(zitadel.configs[0]).toMatchObject({ state: "SMTP_CONFIG_ACTIVE", description: "Vern", host: "smtp.acme.test:587", tls: true, user: "u" });
		expect(zitadel.passwords.get("new1")).toBe("p1");
		expect(zitadel.configs[0]).not.toHaveProperty("password");
	});

	test("changes nothing but the password when only the password could have changed", async () => {
		const zitadel = fakeZitadel();
		await ensureSmtp(zitadel.api, WANTED, { replaceOthers: true });
		zitadel.calls.length = 0;
		const result = await ensureSmtp(zitadel.api, { ...WANTED, password: "p2" }, { replaceOthers: true });
		expect(result.action).toBe("unchanged");
		expect(mutations(zitadel).map((call) => `${call.method} ${call.path}`)).toEqual(["PUT /admin/v1/smtp/new1/password"]);
		expect(zitadel.passwords.get("new1")).toBe("p2");
	});

	test("without a password to set, a second run makes no change at all", async () => {
		const zitadel = fakeZitadel();
		const relay = { host: "relay:25", senderAddress: "a@b.test", senderName: "B", tls: false };
		await ensureSmtp(zitadel.api, relay, { replaceOthers: false });
		zitadel.calls.length = 0;
		expect((await ensureSmtp(zitadel.api, relay, { replaceOthers: false })).action).toBe("unchanged");
		expect(mutations(zitadel)).toEqual([]);
	});

	test("brings a changed setting in line, and activates a configuration that is not active", async () => {
		const zitadel = fakeZitadel();
		await ensureSmtp(zitadel.api, WANTED, { replaceOthers: true });
		zitadel.configs[0].state = "SMTP_CONFIG_INACTIVE";
		const result = await ensureSmtp(zitadel.api, { ...WANTED, host: "smtp.other.test:465", senderName: "Other" }, { replaceOthers: true });
		expect(result).toEqual({ action: "updated", host: "smtp.other.test:465" });
		expect(zitadel.configs[0]).toMatchObject({ state: "SMTP_CONFIG_ACTIVE", host: "smtp.other.test:465", senderName: "Other" });
		expect(zitadel.configs).toHaveLength(1);
	});

	test("replaces another active configuration only when asked to", async () => {
		const other = { id: "c1", state: "SMTP_CONFIG_ACTIVE", host: "smtp.gmail.com:587", description: "Gmail" };
		const kept = fakeZitadel([{ ...other }]);
		expect(await ensureSmtp(kept.api, WANTED, { replaceOthers: false })).toEqual({ action: "kept", host: "smtp.gmail.com:587" });
		expect(mutations(kept)).toEqual([]);

		const replaced = fakeZitadel([{ ...other }]);
		expect((await ensureSmtp(replaced.api, WANTED, { replaceOthers: true })).action).toBe("created");
		expect(replaced.configs.find((config) => config.state === "SMTP_CONFIG_ACTIVE")).toMatchObject({ description: "Vern" });
		expect(replaced.configs.find((config) => config.id === "c1")).toMatchObject({ state: "SMTP_CONFIG_INACTIVE" });
	});

	test("a configuration for the same server, such as the compose file's, is the one wanted", async () => {
		const zitadel = fakeZitadel([{ id: "c1", state: "SMTP_CONFIG_ACTIVE", host: "mailpit:1025", senderAddress: "no-reply@localhost" }]);
		const relay = { host: "mailpit:1025", senderAddress: "no-reply@vern.localhost", senderName: "Vern", tls: false };
		expect(await ensureSmtp(zitadel.api, relay, { replaceOthers: false })).toEqual({ action: "unchanged", host: "mailpit:1025" });
		expect(mutations(zitadel)).toEqual([]);
		expect(zitadel.configs).toHaveLength(1);
	});

	test("with nothing wanted it changes nothing and reports whether mail is set up", async () => {
		const empty = fakeZitadel();
		expect(await ensureSmtp(empty.api, undefined, { replaceOthers: true })).toEqual({ action: "none" });
		const active = fakeZitadel([{ id: "c1", state: "SMTP_CONFIG_ACTIVE", host: "smtp.gmail.com:587", description: "Gmail" }]);
		expect(await ensureSmtp(active.api, undefined, { replaceOthers: true })).toEqual({ action: "kept", host: "smtp.gmail.com:587" });
		expect(mutations(empty)).toEqual([]);
		expect(mutations(active)).toEqual([]);
	});
});
