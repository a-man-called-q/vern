import { type ApiOptions, callApi, isNoChanges } from "./client";

// What a deployment sets in its settings (deploy/<environment>/.env, or
// settings.env on Kubernetes) so ZITADEL can send mail: the invitation,
// email-verification, and password-reset messages all go through it.
export const SMTP_HOST_KEY = "SMTP_HOST";
const SMTP_KEYS = {
	user: "SMTP_USER",
	password: "SMTP_PASSWORD",
	fromAddress: "SMTP_FROM_ADDRESS",
	fromName: "SMTP_FROM_NAME",
	replyTo: "SMTP_REPLY_TO",
	tls: "SMTP_TLS",
} as const;

/** Marks the configuration Vern manages, so one made in the Console is never touched by accident. */
const DESCRIPTION = "Vern";
const SMTP_PATH = "/admin/v1/smtp";

export type SmtpSettings = {
	/** `host:port`, as ZITADEL wants it. */
	host: string;
	user?: string;
	password?: string;
	senderAddress: string;
	senderName: string;
	tls: boolean;
	replyTo?: string;
};

export type SmtpResult = {
	action: "created" | "updated" | "unchanged" | "kept" | "none";
	/** The host mail goes through now, when there is one. */
	host?: string;
};

type SmtpConfig = {
	id: string;
	description?: string;
	host: string;
	user?: string;
	senderAddress: string;
	senderName: string;
	replyToAddress?: string;
	// ZITADEL's JSON leaves out a flag that is false.
	tls?: boolean;
	state: string;
};

/**
 * Reads the SMTP_* variables of a deployment's settings. Nothing set means no mail from
 * this deployment (`undefined`); a half-filled set is a mistake and stops setup
 * before it starts a container.
 */
export function readSmtpSettings(env: Map<string, string>, source: string, defaultSenderName: string): SmtpSettings | undefined {
	const value = (key: string) => env.get(key)?.trim() || undefined;
	const host = value(SMTP_HOST_KEY);
	const others = Object.values(SMTP_KEYS).filter((key) => key !== SMTP_KEYS.tls && value(key));
	if (!host) {
		if (others.length > 0) throw new Error(`${others.join(", ")} set in ${source} without ${SMTP_HOST_KEY}`);
		return undefined;
	}
	const port = host.match(/^[^\s:]+:(\d{1,5})$/)?.[1];
	if (!port || Number(port) < 1 || Number(port) > 65535) {
		throw new Error(`${SMTP_HOST_KEY} must be host:port, such as smtp.example.com:587, in ${source}, not "${host}"`);
	}
	const senderAddress = value(SMTP_KEYS.fromAddress);
	if (!senderAddress || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderAddress)) {
		throw new Error(`${SMTP_KEYS.fromAddress} must be an email address in ${source}`);
	}
	const user = value(SMTP_KEYS.user);
	const password = value(SMTP_KEYS.password);
	if (!user !== !password) throw new Error(`${SMTP_KEYS.user} and ${SMTP_KEYS.password} go together in ${source}`);
	const tls = value(SMTP_KEYS.tls)?.toLowerCase();
	if (tls !== undefined && tls !== "true" && tls !== "false") {
		throw new Error(`${SMTP_KEYS.tls} must be true or false in ${source}, not "${env.get(SMTP_KEYS.tls)}"`);
	}
	return {
		host,
		...(user ? { user, password } : {}),
		senderAddress,
		senderName: value(SMTP_KEYS.fromName) ?? defaultSenderName,
		tls: tls !== "false",
		...(value(SMTP_KEYS.replyTo) ? { replyTo: value(SMTP_KEYS.replyTo) } : {}),
	};
}

function sameSettings(config: SmtpConfig, wanted: SmtpSettings): boolean {
	return (
		config.host === wanted.host &&
		(config.user ?? "") === (wanted.user ?? "") &&
		config.senderAddress === wanted.senderAddress &&
		config.senderName === wanted.senderName &&
		(config.tls === true) === wanted.tls &&
		(config.replyToAddress ?? "") === (wanted.replyTo ?? "")
	);
}

function requestBody(wanted: SmtpSettings) {
	return {
		senderAddress: wanted.senderAddress,
		senderName: wanted.senderName,
		tls: wanted.tls,
		host: wanted.host,
		user: wanted.user ?? "",
		replyToAddress: wanted.replyTo ?? "",
		description: DESCRIPTION,
	};
}

/** ZITADEL answers 400 when a change changes nothing; that is the state we want. */
async function unlessNoChange(call: Promise<unknown>): Promise<void> {
	try {
		await call;
	} catch (error) {
		if (isNoChanges(error)) return;
		throw error;
	}
}

/**
 * Brings ZITADEL's outgoing mail in line with `wanted`. It manages one
 * configuration, the one described as "Vern", and activates it.
 *
 * - With `wanted`, the Vern configuration is created or brought in line, and its
 *   password is set again whenever there is one (ZITADEL never shows it back).
 *   Another active configuration, made in the Console, is replaced only with
 *   `replaceOthers`; without it that configuration stays and nothing changes.
 * - Without `wanted`, nothing changes; the result says whether any mail is
 *   configured, so the caller can say that it is not.
 */
export async function ensureSmtp(
	api: ApiOptions,
	wanted: SmtpSettings | undefined,
	options: { replaceOthers: boolean },
): Promise<SmtpResult> {
	const search = await callApi(api, "POST", `${SMTP_PATH}/_search`, {});
	const configs = (search.result as SmtpConfig[] | undefined) ?? [];
	const ours = configs.find((config) => config.description === DESCRIPTION);
	const active = configs.find((config) => config.state === "SMTP_CONFIG_ACTIVE");

	if (!wanted) return active ? { action: "kept", host: active.host } : { action: "none" };
	if (active && active !== ours && !options.replaceOthers) {
		// The stack's compose file can set the same server up when ZITADEL creates
		// its database; that is the mail setup wanted, not someone else's.
		return { action: active.host === wanted.host ? "unchanged" : "kept", host: active.host };
	}

	if (!ours) {
		const created = await callApi(api, "POST", SMTP_PATH, {
			...requestBody(wanted),
			...(wanted.password ? { password: wanted.password } : {}),
		});
		await callApi(api, "POST", `${SMTP_PATH}/${encodeURIComponent(String(created.id))}/_activate`, {});
		return { action: "created", host: wanted.host };
	}

	const path = `${SMTP_PATH}/${encodeURIComponent(ours.id)}`;
	let changed = false;
	if (!sameSettings(ours, wanted)) {
		await unlessNoChange(callApi(api, "PUT", path, requestBody(wanted)));
		changed = true;
	}
	if (wanted.password) {
		await unlessNoChange(callApi(api, "PUT", `${path}/password`, { password: wanted.password }));
	}
	if (ours.state !== "SMTP_CONFIG_ACTIVE") {
		await callApi(api, "POST", `${path}/_activate`, {});
		changed = true;
	}
	return { action: changed ? "updated" : "unchanged", host: wanted.host };
}
