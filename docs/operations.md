# Operations

## Local verification

From the repository root:

```sh
npm install
npm run dev
npm run check
```

`npm run check` regenerates each Worker's Cloudflare binding types, type-checks every workspace, runs product and infrastructure contract tests, and checks the diff. Generated Worker binding files are intentionally ignored rather than committed in several inconsistent copies.

## Deployment ownership

- `npm run deploy` deploys only `apps/demo`.
- `deploy-native-git-runner.yml` builds and deploys the Sandbox runner remotely on GitHub-hosted infrastructure.
- `deploy-github-bridge.yml` deploys the credential/status bridge.
- `deploy-operator.yml` deploys the operator Worker.
- `os-stack-ci.yml` is evaluated from protected `main`, then validates immutable candidate heads without privileged deployment credentials.
- `os-stack-promote.yml` reads the matching GitHub Actions validation directly, serializes `main` mutation, verifies the tested tree, and deploys.

Ordinary demo releases do not rebuild or reset the runner or bridge Durable Objects.

## Secrets

Repository Actions secrets are installed into the relevant Worker via standard input. Values are never committed or printed. The important categories are:

- `CLOUDFLARE_API_TOKEN` (repository Actions): trusted CI, promotion, and Worker deploys.
- `APP_HARNESS_OPENAI_API_KEY` (repository Actions): provisioning source for the runner's model credential.
- `APP_HARNESS_GITHUB_APP_ID` / `_INSTALLATION_ID` / `_PRIVATE_KEY` (repository Actions): provisioning source for the GitHub App capability Worker.
- `APP_HARNESS_GITHUB_WEBHOOK_SECRET` (repository Actions): provisioning source for the bridge's GitHub webhook secret, installed by `deploy-github-bridge.yml`. The same value is configured on the GitHub App's webhook settings page.
- `OPENAI_API_KEY` (Worker `app-harness-os-native-git`): the only secret the disposable runner holds; repository access uses short-lived installation tokens minted by the GitHub App Worker over a private service binding.
- `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY` (Worker `app-harness-os-git-proxy`): the sole GitHub App identity owner.
- `GITHUB_WEBHOOK_SECRET` (Worker `app-harness-os-git-proxy`): authenticates GitHub webhook deliveries to the bridge's `POST /github/webhook` receiver; part of the GitHub App identity the bridge already solely owns.
- `MODEL_API_KEY` (Worker `app-harness-operator`): optional model-provider credential for the operator's OpenAI-compatible endpoint; unnecessary when an AI Gateway stores the provider key.
- `APP_HARNESS_ADMIN_TOKEN` (repository Actions): provisioning source for the demo Worker's admin bearer token, installed by `provision-runtime-secrets.yml` (target `demo`).
- `ADMIN_TOKEN` (Worker `autonomous-live-chat`): the bearer credential required by the `/api/admin/*` maintenance routes (`Authorization: Bearer <token>`); the routes answer 401 until it is provisioned.
- The demo Worker holds no other secrets; every cross-service call rides a private service binding.
- No promotion callback secret exists: the persistent operator records final workflow evidence in the durable ledger after reading GitHub's immutable run and deployment artifacts. The webhook secret authenticates only the GitHub-to-bridge event push; the bridge-to-ledger hop rides a private service binding, so no callback secret authorizes a ledger write.

Rotate a secret for suspected disclosure or planned lifecycle policy—not as a general retry mechanism. A deployment or upstream outage should resume from durable state with the same uncompromised identity.

## Failure handling

External work uses idempotency IDs, bounded per-call timeouts, one safety-net alarm, and truthful terminal states. Infrastructure interruption is retryable; a structured agent refusal, invalid output, failed check, unsafe migration, or unsupported external dependency moves to review.

The flow is event-driven with exactly two recovery mechanisms. First: every relevant ledger write fires one fire-and-forget poke at the operator; the per-item `OperatorTurn` Durable Object serializes turns, reads a fresh snapshot at each turn start, resumes a crashed turn from its persisted transcript by its own alarm, and re-drives itself after a `WAITING` turn. Second: a five-minute ledger sweep moves expired applying actions to reconciliation and re-pokes every non-terminal item. There are no work-item leases, wake records, delivery attempts, or response leases to babysit — a lost poke is recovered by the next event or the sweep. Two brakes bound runaway work: a lifetime budget of 200 event-driven pokes per item (sweep re-pokes are free — they measure time queued, not activity) and a bounded staged-command rejection budget, each parking the item to `needs_review` with its ledger and artifacts intact.

Every turn ends inside hard tool-call and token caps and a ten-minute envelope; each model call and tool call carries its own timeout, and the loop ends the turn cleanly rather than starting a call that cannot finish inside the envelope.

`OPERATOR_PAUSED=true` is the durable emergency brake. It preserves work items and actions, deletes the room alarm, sends no pokes, and prompts no models. Redeploying with the flag disabled reconstructs the schedule from the ledger; pausing never requires deleting or rewriting work state.

Operator effects use semantic identities such as `work-item:classification`, `work-item:issue`, and the plan/implementation/promotion identifiers. They are not keyed to a transient ledger revision. The ledger also refuses an out-of-order or concurrent mutation. GitHub issue reconciliation reads the repository's recent issue list before using asynchronous search, so search-index lag cannot create another issue for the same durable marker.

Browser connections only read room snapshots and realtime updates. Opening or reconnecting the UI no longer initiates GitHub reconciliation; recovery begins on Durable Object initialization and alarms.

## Acceptance test

Use a small but non-special-cased request in the live app. Confirm, in order: immediate acknowledgement, GitHub issue, classification/status update, agent-authored commit, PR/stack link, candidate checks, promotion, production behavior, final issue label/comment, and completed in-app state. Keep the issue open when any link in that chain is missing.
