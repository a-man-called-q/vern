#!/usr/bin/env bash
# Signs in to a web app on the cluster of deploy/local and checks
# that it reaches its API, with the Playwright test of deploy/smoke. It signs in
# as the ZITADEL admin; on a new instance ZITADEL asks for a new password, which
# the test sets and this script keeps in generated/secrets/admin-password.
# SMOKE_APP names the web app (default: the first under apps/ with a k8s/).

set -euo pipefail

cd "$(dirname "$0")"
secrets="generated/secrets"
playwright_version="1.62.1"

setting() {
  grep -E "^$1=" settings.env 2>/dev/null | tail -1 | cut -d= -f2- || true
}
domain="$(setting DOMAIN)"
domain="${domain:-localtest.me}"
auth_host="$(setting AUTH_HOST)"
auth_host="${auth_host:-auth.${domain}}"
app="${SMOKE_APP:-}"
if [[ -z "$app" ]]; then
  for dir in ../../apps/*/k8s; do
    [[ -d "$dir" ]] || continue
    app="$(basename "$(dirname "$dir")")"
    break
  done
fi
if [[ -z "$app" ]]; then
  echo "No web app with a k8s/ folder under apps/." >&2
  exit 1
fi

org="$(setting ZITADEL_ORG_NAME | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g')"
user="$(setting ZITADEL_ADMIN_USERNAME)"
password="$(grep -E '^ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD=' "$secrets/zitadel.env" | cut -d= -f2-)"
if [[ -s "$secrets/admin-password" ]]; then
  password="$(cat "$secrets/admin-password")"
fi
export AUTH_DOMAIN="$auth_host"
export APP_DOMAIN="${app}.${domain}"
export LOGIN_NAME="${user:-zitadel-admin}@${org:-vern}.${auth_host}"
export PASSWORD="$password"
export NEW_PASSWORD="$(openssl rand -hex 16)Aa1!"

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
chmod 777 "$out"

# The browser runs on this machine's network, where the hostnames reach the
# cluster's ingress on ports 80 and 443.
docker run --rm --network host \
  --volume "$PWD/../smoke:/smoke:ro" --volume "$out:/out" --workdir /work \
  --env AUTH_DOMAIN --env APP_DOMAIN --env LOGIN_NAME --env PASSWORD --env NEW_PASSWORD \
  "mcr.microsoft.com/playwright:v${playwright_version}-noble" \
  sh -c "cp -r /smoke/. . && npm install --silent --no-save --no-package-lock @playwright/test@${playwright_version} && npx playwright test"

if [[ -e "$out/password-changed" ]]; then
  printf '%s' "$NEW_PASSWORD" > "$secrets/admin-password"
  chmod 600 "$secrets/admin-password"
  echo "Set a new admin password; wrote it to deploy/local/$secrets/admin-password."
fi
