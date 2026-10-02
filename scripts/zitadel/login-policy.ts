import { type ApiOptions, callApi, isNoChanges } from "./client";

export const ALLOW_REGISTER_KEY = "ZITADEL_ALLOW_REGISTER";

const POLICY_PATH = "/admin/v1/policies/login";
// ZITADEL rejects an update that changes nothing with this error id.
const NO_CHANGES_ID = "INSTANCE-5M9vdd";
// What PUT /admin/v1/policies/login accepts. The policy it returns also carries
// details, isDefault, and the factor lists, which have their own endpoints.
const UPDATABLE_FIELDS = [
	"allowUsernamePassword",
	"allowRegister",
	"allowExternalIdp",
	"forceMfa",
	"forceMfaLocalOnly",
	"passwordlessType",
	"hidePasswordReset",
	"ignoreUnknownUsernames",
	"defaultRedirectUri",
	"passwordCheckLifetime",
	"externalLoginCheckLifetime",
	"mfaInitSkipLifetime",
	"secondFactorCheckLifetime",
	"multiFactorCheckLifetime",
	"allowDomainDiscovery",
	"disableLoginWithEmail",
	"disableLoginWithPhone",
] as const;

/** `true` or `false`; `undefined` when the variable is missing or empty. */
export function parseAllowRegister(value: string | undefined, source: string): boolean | undefined {
	const text = value?.trim().toLowerCase();
	if (!text) return undefined;
	if (text === "true") return true;
	if (text === "false") return false;
	throw new Error(`${ALLOW_REGISTER_KEY} must be true or false in ${source}, not "${value}"`);
}

/**
 * Brings the instance's login policy in line with ZITADEL_ALLOW_REGISTER. The
 * variable only reaches ZITADEL when it creates its database, so an instance
 * that already exists needs this call. With no value it changes nothing and
 * reports what it found, so the caller can say that sign-up is open.
 */
export async function ensureSelfRegistration(
	api: ApiOptions,
	wanted: boolean | undefined,
): Promise<{ allowed: boolean; changed: boolean }> {
	const { policy } = (await callApi(api, "GET", POLICY_PATH)) as { policy?: Record<string, unknown> };
	if (!policy) throw new Error(`ZITADEL GET ${POLICY_PATH} returned no policy`);
	// A false flag is left out of the JSON, so a missing one means off.
	const allowed = policy.allowRegister === true;
	if (wanted === undefined || wanted === allowed) return { allowed, changed: false };

	// An update replaces the whole policy: send back what is there, changed.
	const settings = Object.fromEntries(UPDATABLE_FIELDS.filter((key) => key in policy).map((key) => [key, policy[key]]));
	try {
		await callApi(api, "PUT", POLICY_PATH, { ...settings, allowRegister: wanted });
	} catch (error) {
		if (isNoChanges(error, NO_CHANGES_ID)) {
			return { allowed: wanted, changed: false };
		}
		throw error;
	}
	return { allowed: wanted, changed: true };
}
