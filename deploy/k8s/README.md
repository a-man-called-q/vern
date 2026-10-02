# Kubernetes

`deploy/k8s` runs the product on Kubernetes with Kustomize (built into
`kubectl`): ZITADEL with the Vern sign-in pages, and every web app and API the
project has, each on its own HTTPS hostname. It is the path for a product that
outgrows the one server of [`deploy/docker-compose.yml`](../README.md), which
stays the simple way to run one web app and one API.

| Path | What it is |
| --- | --- |
| `apps/<name>/k8s`, `services/<name>/k8s` | Each app's Deployment and Service, written by `moon generate` |
| `base/identity` | ZITADEL, its Login App, and the sign-in pages (`auth-pages`) |
| `base/kustomization.yaml` | The identity stack and every app; `setup` rewrites it |
| `overlays/local` | Everything on a laptop cluster (kind), the databases included |
| `overlays/production` | ZITADEL and the apps; the databases come from outside the cluster |
| `overlays/<overlay>/generated/` | What `setup` writes for the overlay: hostnames, images, settings, and Secrets. Not in Git |
| `local-cluster.sh`, `kind.yaml`, `traefik.yaml` | A kind cluster for `overlays/local`, with Traefik |
| `smoke-test.sh` | Signs in on the local cluster (the test of `deploy/smoke`) |

Each web app and API gets the hostname `<name>.<DOMAIN>`, and ZITADEL
`auth.<DOMAIN>`. An app reaches ZITADEL and its APIs by those public HTTPS
hostnames, from inside the cluster too, because the apps refuse plain HTTP in
production.

## On your machine

With Docker, [kind](https://kind.sigs.k8s.io), `kubectl`, and the project's
toolchain:

```sh
deploy/k8s/local-cluster.sh
bun run setup -- --kubernetes local
```

`local-cluster.sh` creates the kind cluster, installs Traefik on ports 80 and
443 of this machine, makes every hostname under `DOMAIN` resolve to Traefik
inside the cluster (`localtest.me` and its subdomains already resolve to
127.0.0.1 here), and builds and loads the image of every app. `setup` then
writes `overlays/local/generated/` (with a local certificate authority,
`generated/tls/ca.pem`), applies the overlay, waits for ZITADEL, creates the
ZITADEL project, an application per web app, and a key per API, and applies
the overlay again with them. Open `https://<web app>.localtest.me`; the
browser warns about the local authority unless you import `ca.pem`.

The local overlay runs one replica of each app, ZITADEL's PostgreSQL, Redis,
and the stacks the project generated under `infra/`: `data` (each API with a
database applies its `db/init.sql` to it before it starts), `bus`, and
`storage` (with its bucket). After changing an app, run `local-cluster.sh`
again to load the new image, then `kubectl -n vern rollout restart
deployment/<app>`.

`deploy/k8s/smoke-test.sh` signs in to the first web app and checks that it
reaches its API, as CI does on every change.

## Production

What the cluster needs first:

- **An ingress controller.** The manifests set `ingressClassName` from
  `INGRESS_CLASS` and work with Traefik (which reads the h2c backend of ZITADEL
  from the `zitadel-api` Service) and with ingress-nginx (from the
  `zitadel-api` Ingress). Another controller needs its own way to reach
  `zitadel-api` over h2c.
- **[cert-manager](https://cert-manager.io)** with a ClusterIssuer
  (`CLUSTER_ISSUER`, `letsencrypt` by default). Every Ingress asks it for its
  certificate.
- **DNS**: `auth.<DOMAIN>` and `<app>.<DOMAIN>` for every app point at the
  ingress controller. Pods call the same hostnames: when the cluster cannot
  reach its own load balancer from inside (some do not hairpin), make CoreDNS
  answer them with the controller's Service, as `local-cluster.sh` does with a
  `rewrite name` rule.
- **The images**, `<IMAGE_REGISTRY>/<app>:<commit>`.
  [`.github/workflows/images.yml`](../../.github/workflows/images.yml) builds
  and pushes every app on each push to `main` (to `ghcr.io/<owner>/<repo>`
  unless the `IMAGE_REGISTRY` variable says otherwise). Give the cluster pull
  access to the registry.
- **The Secrets of the databases**, in the overlay's namespace (`vern`), from
  your operator, managed service, or secret manager. Nothing creates them:

  | Secret | Key | Holds | Read by |
  | --- | --- | --- | --- |
  | `zitadel-database` | `dsn` | `postgresql://user:password@host:5432/zitadel?sslmode=require`, an owner of that database | ZITADEL |
  | `redis` | `url` | `rediss://user:password@host:6379`, the sessions of every web app | the web apps |
  | `<api>-database` | `url` | That API's `DATABASE_URL`, its own database and login role (the statements of its `db/init.sql`) | each API with a database |
  | `bus` | `url` | `NATS_URL` of a NATS server with JetStream | each API with events |

Then:

```sh
cp deploy/k8s/overlays/production/settings.env.example deploy/k8s/overlays/production/settings.env
# set DOMAIN and IMAGE_REGISTRY (and SMTP_* for mail)
bun run setup -- --kubernetes production
```

against the cluster `kubectl` points at. It generates ZITADEL's master key,
the first admin's password, and a session secret per web app, applies the
overlay, and provisions ZITADEL as on the local cluster. It prints the admin to
sign in as; ZITADEL asks for a new password on the first sign-in. Run it again
after generating an app or changing a setting: it keeps what exists. `IMAGE_TAG`
empty means the commit you run it on, which is what the workflow pushed.

**Back up `overlays/production/generated/secrets/`** in a secret manager: it is
not in Git, and `zitadel.env` holds the master key that encrypts ZITADEL's
database. A GitOps tool that applies the overlay needs those Secrets from your
secret manager instead of the files.

## What runs where

| | `overlays/local` | `overlays/production` |
| --- | --- | --- |
| ZITADEL, Login App, sign-in pages | 1 replica | 1 replica |
| Web apps and APIs | 1 replica each | 2 replicas each |
| ZITADEL's PostgreSQL, Redis | in the cluster | your `zitadel-database` and `redis` Secrets |
| `infra/data`, `infra/bus`, `infra/storage` | in the cluster | your `<api>-database` and `bus` Secrets |
| Certificates | a local authority | cert-manager |

ZITADEL and its Login App share one pod and a small volume, where ZITADEL
writes the Login App's token when it creates its database, so they run as one
replica. Each app's `k8s/deployment.yaml` sets its replicas, probes (`/healthz`),
and resources; change them there.
