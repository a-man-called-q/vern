import { describe, expect, test } from "bun:test";
import { toYaml } from "./yaml";

describe("toYaml", () => {
	test("writes what a YAML parser reads back the same", () => {
		const value = {
			kind: "Component",
			resources: ["ingress.yaml", "../backing/data"],
			images: [{ name: "web", newName: "ghcr.io/acme/web", newTag: "0123456" }],
			literals: ["ZITADEL_ISSUER=https://auth.acme.test", "COLOR=#6D5EF5", "true", "yes", "key: value", ""],
			empty: [],
			none: {},
			numbers: [1, 2.5],
			flags: { on: true, off: false },
			nested: [[1, 2], { deep: [{ a: "b" }] }],
			"odd key": "x",
		};
		expect(Bun.YAML.parse(toYaml(value))).toEqual(value);
	});

	test("quotes a value that would read as another type", () => {
		expect(toYaml({ tag: "0123456", flag: "true", word: "plain" })).toBe('tag: "0123456"\nflag: "true"\nword: plain\n');
	});
});
