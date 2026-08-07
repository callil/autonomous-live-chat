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
- `os-stack-ci.yml` is evaluated from protected `main`, then validates immutable candidate heads without privileged deployment credentials.
- `os-stack-promote.yml` reads the matching GitHub Actions validation directly, serializes `main` mutation, verifies the tested tree, and deploys.

Ordinary demo releases do not rebuild or reset the runner or bridge Durable Objects.

## Secrets

Repository Actions secrets are installed into the relevant Worker via standard input. Values are never committed or printed. The important categories are:

- Cloudflare deploy credential;
- OpenAI API credential used inside the coding runner;
- GitHub App ID, installation ID, and private key held by the bridge/runner Worker boundary;
- coordinator/runner HMAC secrets used to bind calls to durable jobs;
- no promotion callback secret: the persistent operator records final workflow evidence in the durable ledger after reading GitHub's immutable run and deployment artifacts.

Rotate a secret for suspected disclosure or planned lifecycle policy—not as a general retry mechanism. A deployment or upstream outage should resume from durable state with the same uncompromised identity.

## Failure handling

External work uses idempotency IDs, durable leases, alarms, bounded retries, and truthful terminal states. Infrastructure interruption is retryable; a structured agent refusal, invalid output, failed check, unsafe migration, or unsupported external dependency moves to review.

Browser connections only read room snapshots and realtime updates. Opening or reconnecting the UI no longer initiates GitHub reconciliation; recovery begins on Durable Object initialization and alarms.

## Acceptance test

Use a small but non-special-cased request in the live app. Confirm, in order: immediate acknowledgement, GitHub issue, classification/status update, agent-authored commit, PR/stack link, candidate checks, promotion, production behavior, final issue label/comment, and completed in-app state. Keep the issue open when any link in that chain is missing.
