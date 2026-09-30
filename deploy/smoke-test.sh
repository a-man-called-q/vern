#!/usr/bin/env bash
# Signs in to the running production stack with a browser in a container on its
# network, and checks that the web app reaches the API. It signs in as the
# ZITADEL admin from deploy/.env; on a new stack ZITADEL asks for a new
# password, which the check sets and writes back to ZITADEL_ADMIN_PASSWORD.

set -euo pipefail

cd "$(dirname "$0")"

playwright_version="1.62.1"

setting() {
  grep -E "^$1=" .env | tail -1 | cut -d= -f2-
}
org="$(setting ZITADEL_ORG_NAME | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g')"
user="$(setting ZITADEL_ADMIN_USERNAME)"
export AUTH_DOMAIN="$(setting AUTH_DOMAIN)"
export APP_DOMAIN="$(setting APP_DOMAIN)"
export LOGIN_NAME="${user:-zitadel-admin}@${org:-vern}.${AUTH_DOMAIN}"
export PASSWORD="$(setting ZITADEL_ADMIN_PASSWORD)"
export NEW_PASSWORD="$(openssl rand -hex 16)Aa1!"

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
chmod 777 "$out"

docker run --rm --network vern-edge \
  --volume "$PWD/smoke:/smoke:ro" --volume "$out:/out" --workdir /work \
  --env AUTH_DOMAIN --env APP_DOMAIN --env LOGIN_NAME --env PASSWORD --env NEW_PASSWORD \
  "mcr.microsoft.com/playwright:v${playwright_version}-noble" \
  sh -c "cp -r /smoke/. . && npm install --silent --no-save --no-package-lock @playwright/test@${playwright_version} && npx playwright test"

if [[ -e "$out/password-changed" ]]; then
  tmp="$(mktemp)"
  awk -v value="$NEW_PASSWORD" 'BEGIN { FS = OFS = "=" } $1 == "ZITADEL_ADMIN_PASSWORD" { print $1, value; next } { print }' .env > "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
  echo "Set a new admin password; wrote it to ZITADEL_ADMIN_PASSWORD in deploy/.env."
fi
