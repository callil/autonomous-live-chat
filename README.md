# App Harness

App Harness is a small, real demonstration of software that can receive situated feedback, turn it into repository work, verify that work with CI, and update itself in public.

The host product is intentionally simple: a live multi-user chat room served by its own Cloudflare Worker. The frozen platform serves an authoring overlay into that page; anyone in the room can point at the interface and describe a change. The platform's room Durable Object records the request in an append-only ledger, dispatches a disposable sandboxed coding run, squash-merges the verified PR at its exact head SHA, and posts "Live" only once it observes the deployed product actually serving the merged revision.

- Live room: [app-harness-product.coda-a.workers.dev](https://app-harness-product.coda-a.workers.dev)
- Documentation: [docs/README.md](./docs/README.md)

## Repository map

```text
platform/                  the FROZEN platform Worker: room ledger, queue, reconciler,
                           deploy rails, session auth, authoring overlay, fallback UI
platform/runner/           the platform's sandbox runner Worker (one container per run)
product/                   the self-modifiable product: the room UI the agent may rewrite
.github/workflows/         CI, the platform firewall, and the deploy legs
docs/                      product, architecture, operations, and safety
```

The split is the safety model: agent branches (`room/*`) may only change `product/`. The platform firewall fails any agent diff touching `platform/`, CI configuration, dependency manifests, or wrangler configs. The overlay, the build queue, and the activity feed are served by the frozen platform, so an agent change to the app can never break or falsify the status surface that reports on its own builds.

## Quickstart for contributors

Requires Node.js 22.

```sh
npm install
npm run check       # generated Cloudflare types, TypeScript, all test layers
npm run smoke       # post-deploy checks against the real deployed origin
```

Then read [docs/README.md](./docs/README.md) in order — product, architecture,
and the [pipeline lifecycle](./docs/pipeline.md) are enough to orient. The
rules that matter most:

- Humans change `platform/` on ordinary branches; agents (`room/*`) may only
  change `product/`. CI config, dependency manifests, lockfiles, and wrangler
  configs are frozen surfaces (new dependencies are human-gated).
- Platform merges auto-deploy the runner: never land a `platform/**` merge
  while a build run is in flight (check the room's queue chips first).
- Tests assert behaviour and invariants, never copy or source text — read
  [the testing doctrine](./docs/testing.md) before adding one.

## Deployed services

| Worker | Source | Deploy leg |
| --- | --- | --- |
| `app-harness-platform` | `platform/` | `deploy-platform.yml` (push to main touching `platform/**`) |
| `app-harness-platform-runner` | `platform/runner/` | `deploy-platform.yml` (deployed before the platform Worker) |
| `app-harness-product` | `product/` | `deploy-product.yml` (push trigger or reconciler dispatch, exact-SHA stamped into `/version`) |

The end-to-end path, trust boundaries, and current limitations are described in [the architecture guide](./docs/architecture.md).
