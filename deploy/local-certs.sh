#!/usr/bin/env bash
# Creates a local certificate authority and a certificate for AUTH_DOMAIN,
# APP_DOMAIN, and API_DOMAIN from deploy/.env, for
# deploy/docker-compose.local.yml. The files go to deploy/.local/, which Git
# ignores. They are for trying the production stack locally only.

set -euo pipefail

cd "$(dirname "$0")"

setting() {
  grep -E "^$1=" .env | tail -1 | cut -d= -f2-
}
auth_domain="$(setting AUTH_DOMAIN)"
app_domain="$(setting APP_DOMAIN)"
api_domain="$(setting API_DOMAIN)"
if [[ -z "$auth_domain" || -z "$app_domain" || -z "$api_domain" ]]; then
  echo "Set AUTH_DOMAIN, APP_DOMAIN, and API_DOMAIN in deploy/.env first." >&2
  exit 1
fi

mkdir -p .local
cd .local

openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Vern local CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout ca-key.pem -out ca.pem 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=${auth_domain}" -keyout key.pem -out cert.csr 2>/dev/null
printf 'subjectAltName=DNS:%s,DNS:%s,DNS:%s\nextendedKeyUsage=serverAuth\n' "$auth_domain" "$app_domain" "$api_domain" > cert.ext
openssl x509 -req -in cert.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 30 \
  -extfile cert.ext -out cert.pem 2>/dev/null
rm -f cert.csr cert.ext ca.srl
chmod 644 ca.pem cert.pem key.pem

cat > traefik-tls.yml <<'EOF'
tls:
  stores:
    default:
      defaultCertificate:
        certFile: /local/cert.pem
        keyFile: /local/key.pem
EOF

echo "Created deploy/.local/ with a certificate for ${auth_domain}, ${app_domain}, and ${api_domain}."
