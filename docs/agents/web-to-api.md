# Protect a page, and call an API from a web app

The web apps are a backend for the browser: the user's tokens stay in Redis on
the server, and the browser only holds a session cookie. So every call to an
API starts in server code. The API has no CORS and the browser has no token;
a `fetch` to the API from a component cannot work and must not be made to.

The working example in both templates is the dashboard:
`src/server/dashboard.server.ts` requires a user, calls `GET /api/me`, checks
the answer, and handles a lost session.

## The parts, in `src/server`

| Use | From | For |
| --- | --- | --- |
| `getCurrentUser()` | `auth.server` | The signed-in user (`sub`, `name`, `email`) or `null`. For pages that work signed out |
| `requireUser()` | `auth.server` | The user, or a redirect to `/auth/login`. For pages that need sign-in |
| `redirectToLogin()` | `auth.server` | Sends the user to sign in. It never returns |
| `fetchAuthenticatedApi(path, init)` | `api.server` | A `fetch` to the API with the user's access token, refreshed when needed. `path` starts with one `/` |
| `AuthenticationRequiredError` | `auth.server` | Thrown when the session is gone or the API refused the token. Answer it by sending the user to sign in |

`src/server/auth.server.ts` is a few lines: it makes the app's sign-in with
`createWebAuth({ appId })` from `@vern/web-auth` and exports what the table
lists. The flow itself, the session in Redis, and the token refresh are in
`packages/web-auth`, which every web app of the project shares.

Links to sign in and out are plain `<a href="/auth/login">` and a POST form to
`/auth/logout`, as `AuthControls` in `packages/app-shell` has them.

## Next.js

Server Components, Server Actions, and Route Handlers are server code. Files in
`src/server` import `server-only`, so importing one from a client component
fails the build.

```tsx
// src/app/invoices/page.tsx
import { listInvoices } from "@/server/billing.server";

export default async function InvoicesPage() {
	const invoices = await listInvoices();
	return <InvoiceTable invoices={invoices} />;
}
```

A change (create, update, delete) is a Server Action in a `"use server"` file
that calls the same server module, then `revalidatePath`.

## TanStack Start

A route's `loader` runs on the server for the first render and in the browser
after that, so it must not import server code directly. Wrap the call in a
server function, in a file without `.server` in its name, that imports the
`.server` module inside the handler, as `src/server/auth.ts` does:

```ts
// src/server/billing.ts
import { createServerFn } from "@tanstack/react-start";

export const listInvoicesFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { listInvoices } = await import("./billing.server");
		return listInvoices();
	},
);
```

```tsx
// src/routes/invoices.tsx
export const Route = createFileRoute("/invoices")({
	loader: () => listInvoicesFn(),
	component: Invoices,
});
```

A change is a server function with `method: "POST"` and an input validator,
called from the component, followed by `router.invalidate()`.

## One server module per API

Put the calls to an API in one module, `src/server/<api>.server.ts`, with the
types next to it in `src/types`. Pages then call `listInvoices()`, not
`fetchAuthenticatedApi`, and the handling below is written once.

```ts
// src/server/billing.server.ts
export async function listInvoices(): Promise<Invoice[]> {
	await requireUser();
	return call<Invoice[]>("/api/invoices");
}
```

Write one small `call` helper in that module (the templates do not ship one;
`dashboard.server.ts` shows the same steps for a single call). It does four
things:

1. Calls `fetchAuthenticatedApi`, and on `AuthenticationRequiredError` sends
   the user to sign in with `redirectToLogin()`. A `401` that arrives as a response
   instead means the API is misconfigured (the session is under a minute old),
   so treat it as an error; redirecting would loop through sign-in.
2. On an error status, reads the API's error body,
   `{"error":{"code":"...","message":"..."}}`, and throws an error that carries
   the status and that `message`. Messages of 400, 403, and 404 are written for
   users; show a general message for 5xx.
3. Checks that the body has the shape the type claims before returning it, at
   least for the fields the page depends on.
4. Logs failures with `logAuthWarning` from `@vern/web-auth/next` (or
   `/tanstack`), which never writes tokens.

## Roles in the UI

The session holds who the user is, not their roles. Ask the API: `GET /api/me`
returns `roles`. Use them to hide what a user cannot use, or to send a user
without the role to a "no access" page. That is for a clean UI only: the API
checks the role again on every request
([service-engineering.md](service-engineering.md)).

## Rules

- Never pass a user ID, an owner, or a role to the API as data. The API takes
  them from the token.
- Never return a token, the session, or an API key from server code to a
  component, and never log one.
- A path given to `fetchAuthenticatedApi` is built from fixed text and encoded
  IDs (`encodeURIComponent`), never from a URL the browser sent.
- When an API response changes, change the type, the check in `call`, and the
  pages that read it in the same change.
- Do not edit `auth.server.ts`, `api.server.ts`, or the `/auth` routes to add
  product features, and do not copy code out of `packages/web-auth` into an app.
  A change to sign-in itself is made in `packages/web-auth`, where every web app
  gets it; if the stored session shape must change, bump `SESSION_VERSION` in
  `packages/web-auth/src/core/session-record.ts`.

## Shared between web apps

What two web apps need is not copied from one to the other. Sign-in is in
`packages/web-auth` and the frame around the pages in `packages/app-shell`
(see [new-app.md](new-app.md)). When a second app needs the same calls to an
API, the same form, or the same formatting, make it a package: a folder under
`packages/` with a `package.json` named `@vern/<name>` and a `moon.yml`, like
its neighbours, and `"@vern/<name>": "workspace:*"` in each app that uses it.
A package takes what differs between apps as arguments (the client made by
`createApiClient`, the app's name), so it imports nothing from an app.

## Check

`moon run <app>:check <app>:test`. `packages/web-auth/src/core/api.test.ts`
shows how to test a call to an API with a fake `fetch`.
