#!/usr/bin/env bash
# Prepares a kind cluster for the overlay in this folder:
#   - Traefik as the ingress controller, on ports 80 and 443 of this machine;
#   - inside the cluster, every hostname under DOMAIN resolves to Traefik, as
#     it does for a browser here (the apps call ZITADEL and the APIs by their
#     public HTTPS hostnames);
#   - the image of every web app and API, built and loaded into the cluster.
# Then run `bun run setup -- --kubernetes local`. Needs Docker, kind, kubectl,
# and Moon. Run it again after changing an app to load the new images.

set -euo pipefail

cd "$(dirname "$0")"
root="$(cd ../.. && pwd)"
cluster="${KIND_CLUSTER:-vern}"

domain="localtest.me"
if [[ -f settings.env ]]; then
  value="$(grep -E '^DOMAIN=' settings.env | tail -1 | cut -d= -f2-)"
  domain="${value:-$domain}"
fi

if ! kind get clusters 2>/dev/null | grep -qx "$cluster"; then
  kind create cluster --name "$cluster" --config kind.yaml --wait 120s
fi
kubectl config use-context "kind-$cluster" >/dev/null

kubectl apply -f traefik.yaml
kubectl -n traefik rollout status deployment/traefik --timeout=180s

# CoreDNS answers <anything>.DOMAIN with Traefik's Service.
escaped="${domain//./\\.}"
rule="rewrite name regex (.+)\\.${escaped} traefik.traefik.svc.cluster.local answer auto"
corefile="$(kubectl -n kube-system get configmap coredns -o jsonpath='{.data.Corefile}')"
if ! grep -qF "$rule" <<<"$corefile"; then
  patched="$(awk -v rule="    $rule" '{ print } /^\.:53 \{/ && !done { print rule; done = 1 }' <<<"$corefile")"
  kubectl -n kube-system create configmap coredns --from-literal=Corefile="$patched" \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n kube-system rollout restart deployment/coredns
  kubectl -n kube-system rollout status deployment/coredns --timeout=120s
fi

# `moon run <app>:docker` tags each image <app>:latest, which this overlay uses.
cd "$root"
apps=()
for dockerfile in apps/*/Dockerfile services/*/Dockerfile; do
  [[ -e "$dockerfile" ]] || continue
  apps+=("$(basename "$(dirname "$dockerfile")")")
done
if (( ${#apps[@]} > 0 )); then
  moon run "${apps[@]/%/:docker}"
  kind load docker-image --name "$cluster" "${apps[@]/%/:latest}"
fi

echo "kind cluster ${cluster} is ready for ${domain}. Next: bun run setup -- --kubernetes local"
