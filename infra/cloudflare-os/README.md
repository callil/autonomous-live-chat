# Cloudflare OS integration overlay

This is a small, pinned overlay on Cloudflare OS—not a fork. It makes the
existing App Harness durable ledger available as one ambient Cloudflare OS
capability, `App Harness operator`.

It keeps a single owner for each concern:

- **App Harness ledger** owns work items, commands, leases, retries,
  idempotency keys, and public status.
- **Cloudflare OS** owns the interactive model session and approval UX.
- **Native runner** owns a disposable Sandbox/NanoCodex implementation run.
- **GitHub App capability** owns repository-scoped GitHub calls.

The Gatekeeper is deliberately stateless. It makes private Worker RPC calls to
those services; it does not introduce a second database, queue, retry loop, or
HTTP control plane.

Its agent-facing RPC schema is exact and flat. Classification exposes every
required field and allowed value directly; the operator never has to discover
an opaque nested union by trial and error. The model selects commands, while
the ledger enforces only state, lease, ordering, and idempotency invariants.

## Reproduce the integration

Clone the exact upstream revision, apply the reviewed overlay, then generate
the Workshop config used for this deployment. The generated config has exactly
one Gatekeeper binding: `GATEKEEPER_APP_HARNESS`. It intentionally removes the
old custom-execution and GitHub OAuth Gatekeepers from this target deployment.

```sh
git clone https://github.com/cloudflare/cloudflare-os.git /tmp/cloudflare-os
git -C /tmp/cloudflare-os checkout --detach 0eaec6c5e8fc6b3298ea1aa73bf5c3e47b923c7f

node infra/cloudflare-os/scripts/verify.mjs
node infra/cloudflare-os/scripts/apply-overlay.mjs --checkout /tmp/cloudflare-os
node infra/cloudflare-os/scripts/generate-workshop-config.mjs \
  --checkout /tmp/cloudflare-os \
  --output /tmp/cloudflare-os/wrangler.app-harness.json
```

Use the generated `wrangler.app-harness.json` only for the Workshop Worker.
The operator Gatekeeper is a separate private Worker from the overlay package.
Its `LEDGER`, `RUNNER`, and `GITHUB` service bindings are direct RPC bindings,
not public URLs.

## Ambient provisioning

The reviewed text patch changes Cloudflare OS's fresh default admin config to
enable the `app_harness` vendor. (Cloudflare OS derives that identifier from
the `GATEKEEPER_APP_HARNESS` binding name.) That makes the single App Harness account
available to authorized Workshop users without a connection/OAuth screen.

This default is applied only when Cloudflare OS initializes its admin config.
For an already-running Workshop, the persisted Admin Config remains the source
of truth: enable the `app_harness` ambient vendor there rather than assuming a
redeploy changes existing settings.

## Review boundary

`patches.json` is the review record: it pins every overlay file, the exact
upstream text change, and the required invariants. `integration.manifest.json`
is the explicit Workshop attachment contract. `deployment.manifest.json`
names the three private RPC dependencies and forbids local persistence in the
Gatekeeper.

Before deployment, validate the generated source in a detached upstream tree:

```sh
node infra/cloudflare-os/scripts/verify.mjs
pnpm --dir /tmp/cloudflare-os --filter @app-harness/operator-gatekeeper types:check
```

No command in this directory deploys infrastructure or changes the demo app.
