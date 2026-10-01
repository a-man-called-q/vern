# Roles, test users, and managing users

Users and their roles live in ZITADEL, not in the product's database. The
product declares its roles in a file, checks them in the APIs, and, when it
needs a screen for it, manages users through ZITADEL's API.

## Add a role

1. Add it to `roles.json` at the repository root, as a key or with a display
   name and group:

   ```json
   ["member", { "key": "accountant", "displayName": "Accountant", "group": "Staff" }]
   ```

2. Run `bun run setup`. It creates the roles that are missing on the ZITADEL
   project, locally and with `--deploy`. It never changes or deletes a role;
   rename or remove one in the ZITADEL Console.
3. Check it in the API: `user.require_role("accountant")?` at the top of a
   handler ([service-engineering.md](service-engineering.md)).

Keep roles few and about what a person may do in the product (`admin`,
`accountant`), not about single screens or buttons. Who owns which row is data
in the service's own tables, not a role.

## Have someone to sign in as

Local test users are listed in `seed-users.json`, next to `roles.json`:

```json
{
  "adminRoles": ["admin"],
  "users": [
    { "name": "accountant", "givenName": "Demo", "familyName": "Accountant", "roles": ["accountant"] },
    { "name": "member", "givenName": "Demo", "familyName": "Member", "roles": ["member"] }
  ]
}
```

`bun run setup` grants `adminRoles` to the admin (`zitadel-admin@vern.localhost`)
and creates each user as `<name>@vern.localhost`. They share the password in
`ZITADEL_SEED_PASSWORD` in `apps/auth-server/.env`, which `setup` generates; the
admin's is `ZITADEL_ADMIN_PASSWORD` in the same file.

- Add one user per role, plus one without any role, so every access rule can be
  tried from both sides.
- Every role named here must be in `roles.json`; `setup` and
  `bun run project:doctor` stop on a mistake.
- It is additive: an existing user only gets the roles it lacks.
- It is local only. It never runs with `--deploy` or against a ZITADEL that is
  not on this machine. Do not work around that, and never put a password in a
  committed file.
- A role granted to someone who is signed in may not show until they sign out
  and in again.

## A product screen that manages users

Inviting users or granting roles from the product needs a credential for
ZITADEL's API. Create one that can only manage users, for the one app that has
the screen:

```sh
bun run zitadel:service-account -- --app backoffice
```

It writes `ZITADEL_USER_ADMIN_TOKEN` to that app's `.env`.

- Use it from server code only, in a module such as
  `src/server/zitadel-admin.server.ts`, against `ZITADEL_ISSUER`.
- Check that the caller holds the product's admin role before every call made
  with it: the token can change any user of the organization.
- Never use the token `setup` signs in with (`ZITADEL_PAT`, or the one in the
  auth stack) in an app. It can do everything in ZITADEL.
- In production, users and roles are managed in the Console or through this
  service account; test users are never seeded there.
