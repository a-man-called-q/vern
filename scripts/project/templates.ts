/** The web templates: each has a `package.json.tera` the scripts render and upgrade. */
export const WEB_TEMPLATES = [
	{ template: "tanstack", label: "TanStack" },
	{ template: "next", label: "Next.js" },
] as const;
