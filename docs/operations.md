# Operations

## Local verification

From the repository root:

```sh
npm install
npm run check
```

`npm run check` regenerates each Worker's Cloudflare binding types, type-checks every workspace, runs all test layers, and checks the diff. `npm run smoke -- --url <origin>` runs the post-deploy checks against a real deployed origin.

## Deployment ownership

- `deploy-platform.yml` deploys the platform runner and then the platform Worker on every push to main touching `platform/**`. Agent branches can never reach this path — the platform firewall fails any `room/*` diff touching frozen surfaces. **Do not land a `platform/**` merge while a run is in flight**: the runner deploy resets sandbox Durable Objects and can kill a live build mid-run. Check the queue (feed chips, or `POST /api/admin/events` filtered to run facts) before merging platform changes.
- `deploy-product.yml` deploys the product Worker. It triggers on pushes to main touching `product/**` and on reconciler dispatch with an exact SHA (also how reverts execute). The deployed SHA is stamped into `/version`; the platform posts "Live" only when it observes that endpoint serving the merged revision.
- `smoke-after-deploy.yml` runs the smoke layer against the deployed origin after each product deploy.
- One global concurrency group serializes product deploys so a revert can never race a forward deploy.

## Secrets

Repository Actions secrets are installed into the relevant Worker via `provision-runtime-secrets.yml` (workflow_dispatch, targets `platform` and `platform-runner`). Values are never committed or printed.

- `CLOUDFLARE_API_TOKEN` (repository Actions): Worker deploys and secret provisioning.
- `APP_HARNESS_ADMIN_TOKEN` → `ADMIN_TOKEN` on `app-harness-platform`: the owner bearer for `/api/admin/*` (freeze, unfreeze, revert) and the session-signing key derivation. The routes answer 401 until it is provisioned.
- `APP_HARNESS_GITHUB_APP_ID` / `_INSTALLATION_ID` / `_PRIVATE_KEY` → the platform Worker's GitHub App identity (check-run reads, exact-SHA squash merges, workflow dispatch, installation tokens for the runner).
- `APP_HARNESS_PLATFORM_WEBHOOK_SECRET` → `GITHUB_WEBHOOK_SECRET` on the platform: authenticates the repository webhook pointing at `POST /api/hooks/poke`.
- `APP_HARNESS_OPENAI_API_KEY` → `OPENAI_API_KEY` on `app-harness-platform-runner` (the coding agent) and on `app-harness-platform` (the Doctor; optional — absent, the Doctor degrades to the deterministic park-for-human stub).
- The product Worker (`app-harness-product`) holds no secrets at all.

Rotate a secret for suspected disclosure or planned lifecycle policy — not as a general retry mechanism.

## Failure handling

The reconciler is level-triggered: it re-reads durable state every cycle, so a lost webhook or a crashed cycle costs seconds (active cadence) to a minute (idle floor), never the item. Every waiting phase has a TTL that parks the run with an honest public reason and queues a Doctor case. The Doctor's only levers are `stay-parked` and one `retry-once`; every consult failure fails open to park-for-human. Runner results ride a push callback guarded by the per-dispatch runId (bearer) and attemptId (zombie guard); replays and stale attempts are inert.

Owner levers, all requiring the ADMIN_TOKEN bearer (`Authorization: Bearer <token>`):

- `POST /api/admin/freeze` / `POST /api/admin/unfreeze` — pause request intake and dispatch; chat stays open.
- `POST /api/admin/revert {"sha": "<full sha>"}` — deploy a prior good revision, bypassing the pipeline; completes only on `/version` observation.
- `POST /api/admin/events {"kinds": ["run-timing"], "count": 50, "beforeSeq": 123}` — read-only, bounded export of raw ledger facts for offline analysis (all fields optional). This is how per-phase run timings (`run-timing` facts carry bootMs/cloneMs/agentMs/testMs/pushMs/prMs/totalMs plus mode and effort) and outcome-by-mode are audited; it never mutates anything.

## Acceptance test

Use a small but non-special-cased request in the live room. Confirm, in order: the request acknowledgement with its cancel window, run dispatch, live runner progress in the feed, PR link, CI verification, exact-SHA merge, deploy request, "Live" only after the deploy is observed serving, and the post-deploy liveness window passing. Park with a public reason counts as an honest outcome; silence does not.
