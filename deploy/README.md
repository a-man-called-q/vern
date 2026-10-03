# Deploy

`deploy/` answers one question: how is this product run? It has one folder per
environment, and two folders with what the environments share.

| Folder | What it is |
| --- | --- |
| `dev/` | What the apps depend on while you develop, as Docker Compose stacks: `auth-server` (ZITADEL, Redis, Mailpit) and the `postgres`, `bus`, and `storage` projects you generate. The apps themselves run from source, with `moon run <app>:dev` |
| `local/` | The whole product on your machine, built as it is for production: a rehearsal, not the daily loop |
| `staging/` | The whole product, to try a change before production |
| `prod/` | Production |
| `compose/` | The Docker Compose stack that runs the whole product on one server. [compose/README.md](compose/README.md) |
| `base/` | The Kubernetes manifests every overlay shares. [base/README.md](base/README.md) |
| `smoke/` | The browser test that signs in through a running environment |

`dev/` is Compose for the dependencies only. `local/`, `staging/`, and `prod/`
run everything: ZITADEL with the sign-in pages, the web apps, and the APIs,
each on its own HTTPS hostname.

## Two ways to run an environment

Each of `local`, `staging`, and `prod` runs in one of two ways. Choose per
environment; they do not have to match.

| | Docker Compose | Kubernetes |
| --- | --- | --- |
| Runs | One web app and one API, on one server | Every web app and API, with replicas |
| Shared definition | `compose/docker-compose.yml` | `base/` |
| The environment's folder holds | `.env` (its hostnames and secrets) and `secrets/` | `kustomization.yaml` (its overlay), `settings.env`, and `generated/` |
| First run | `bun run setup -- --compose <environment>` | `bun run setup -- --kubernetes <environment>` |
| Guide | [compose/README.md](compose/README.md) | [base/README.md](base/README.md) |

An environment's folder holds only what differs from the others, so staging
cannot drift from production: both are the same Compose file, or the same
`base/`, with other hostnames and secrets.

## Keep only what you use

A new project carries both ways. Say how each environment runs, and the project
keeps only that:

```sh
bun run project:stack -- --local kubernetes --staging none --prod kubernetes
```

| Environment | Choices |
| --- | --- |
| `local` | `none`, `compose`, `kubernetes` (a kind cluster) |
| `staging` | `none`, `compose`, `kubernetes` |
| `prod` | `compose`, `kubernetes` |

`create-vern` asks the same three questions when it creates the project. The
choice is saved in `.vern/config.json`, and this is what goes:

| When | Removed |
| --- | --- |
| No environment uses Docker Compose | `compose/` |
| No environment uses Kubernetes | `base/`, every app's `k8s/` and the templates' (so `moon generate` writes none), and `.github/workflows/images.yml` |
| An environment does not run on Kubernetes | Its overlay: the files of its folder that are in Git. With `none`, the folder itself |

What `setup` wrote into an environment's folder (`.env`, `settings.env`,
`secrets/`, `generated/`, `certs/`) is never deleted: Git ignores it, and it may
hold a key that cannot be recreated. The command lists what is left, for you to
delete. It refuses to delete a file with changes that are not committed.

Run it again with another choice (only the environments that change need
naming) and Vern's files come back, from the release the project is on.
`bun run project:update` leaves out upstream's files of a way the project does
not use, and `bun run project:doctor` says when the project and the choice have
drifted apart. `dev/` is not a choice: it is always Docker Compose for what the
apps depend on, with the apps running from source.

Nothing that `setup` writes there is in Git: `.env`, `settings.env`, `secrets/`,
`generated/`, and `local/certs/`. Back up the ones of `staging` and `prod` in a
secret manager; each guide says which hold a key that cannot be recreated.

## Run it again

These set an environment up, or run it again the same way (`setup` takes the
way from the project's choice, or else tells Docker Compose from Kubernetes by
the settings file in the folder):

```sh
moon run deploy:local
moon run deploy:staging
moon run deploy:prod
```

They are `bun run setup -- --env <environment>`. It is safe to run again: it
keeps what exists, applies changed settings, and deploys the current code.
With Docker Compose it builds the images on the server; on Kubernetes the
images come from the registry, where `.github/workflows/images.yml` pushes them
on every push to `main` (`local/local-cluster.sh` builds and loads them for the
kind cluster).

## Staging and production

They are set up the same way, with their own hostnames. On Kubernetes,
`staging/` puts everything in its own namespace (`vern-staging`) with one
replica of each app, so it can share a cluster with production or have its
own. With Docker Compose, staging is a second server with its own checkout:
the stack takes ports 80 and 443 and is one Compose project, so two
environments do not share a machine.
