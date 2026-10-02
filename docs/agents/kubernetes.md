# Deploy to Kubernetes

`deploy/base` runs ZITADEL and every web app and API on Kubernetes, with
Kustomize, and each environment (`deploy/local`, `deploy/staging`,
`deploy/prod`) is an overlay on it.
[deploy/base/README.md](../../deploy/base/README.md) is the full guide; this is
what to know before changing it.

## Where things are

- **An app's own manifests** are `apps/<name>/k8s/` or `services/<name>/k8s/`:
  a Deployment and a Service that `moon generate` wrote. Change replicas,
  resources, probes, or an extra environment variable there.
- **`deploy/base/kustomization.yaml` lists the apps.** `bun run setup --
  --kubernetes <environment>` rewrites it; after generating an app, run it (with
  `--manifests-only` to only write the files). Do not edit it by hand.
- **Hostnames, images, and settings** come from the environment's
  `settings.env` and land in `deploy/<environment>/generated/`, which `setup` writes and Git
  ignores. Do not edit `generated/`: change `settings.env` or the app and run
  `setup` again.
- **Secrets never go in a manifest.** `setup` writes the ones it creates
  (ZITADEL's master key, session secrets, client IDs, API keys) to
  `generated/secrets/`, read by Kustomize's `secretGenerator`. In production,
  the database, Redis, and bus Secrets come from outside (the table in the
  README).

## Rules

1. **An app calls ZITADEL and other apps by their public HTTPS hostname**, never
   by a Service name over HTTP. The HTTPS guards stay; inside the cluster the
   hostnames resolve to the ingress (the README's DNS note).
2. **A new setting an app reads** goes in its `.env.example` as usual. For
   Kubernetes, a setting that is the same everywhere goes in the app's
   `k8s/deployment.yaml` (`env:`); a secret one goes in a Secret it reads with
   `secretKeyRef`, listed in the README's table when the operator provides it.
3. **An endpoint a probe calls** is `/healthz`: public, and it calls nothing.
   Keep it that way.
4. **A new backing service** (a queue, a cache) runs in `deploy/local` like
   `backing/bus`, and production reads its URL from a Secret the README lists.
5. **What differs between environments goes in the overlay, never in a copy.**
   A change for staging only is a patch in `deploy/staging/kustomization.yaml`
   (as its replica count is); everything else stays in `deploy/base` or the
   app's `k8s/`, so staging and production cannot drift.

## Check

```sh
bun run setup -- --kubernetes local --manifests-only
kubectl kustomize deploy/local > /dev/null
```

CI renders every overlay for a project with two web apps and two APIs,
validates them against the Kubernetes schemas, and signs in through
`deploy/local` on a kind cluster.
