# App Harness

App Harness is a small, real demonstration of software that can receive situated feedback, turn it into repository work, validate that work as an ordered stack, and update itself in public.

The host product is intentionally simple: a live multi-user chat backed by a Cloudflare Worker and one Durable Object per room. A summonable overlay lets someone point at the interface and describe a change. The durable coordinator publishes the request to GitHub and hands eligible implementation work to a bounded operator Worker and an isolated coding runner.

- Live demo: [autonomous-live-chat.coda-a.workers.dev](https://autonomous-live-chat.coda-a.workers.dev)
- Operator status: [app-harness-operator.coda-a.workers.dev/status](https://app-harness-operator.coda-a.workers.dev/status)
- Documentation: [docs/README.md](./docs/README.md)

## Repository map

```text
apps/demo/                 live chat frontend + Worker/Durable Object backend
packages/contracts/        shared platform and authoring-envelope policy
packages/react/            reusable React authoring overlay
infra/orchestration/       durable job, stack, and provider contracts
infra/workers/             operator Worker + isolated coding runner + GitHub credential bridge
infra/scripts/             trusted CI and promotion checks
infra/tests/               infrastructure contract tests
.github/workflows/         validation, stack promotion, and deployments
docs/                      product, architecture, operations, and safety
```

These are clear ownership boundaries, not an agent sandbox. The autonomous agent defaults to changing `apps/demo`, including both frontend and backend, but it can change the React package or infrastructure whenever a complete product change requires it.

## Run locally

Requires Node.js 22.

```sh
npm install
npm run dev
```

Open the local URL in two browser windows to verify room synchronization.

Useful checks:

```sh
npm run check       # generated Cloudflare types, TypeScript, contracts, tests
npm run deploy      # deploy only the demo app
```

Infrastructure services have separate, explicit deployment workflows. Ordinary app deployment does not rebuild the coding runner or credential bridge.

## What persists where

The room does not impose product-level character or history-count caps. Messages and collaboration records are stored as individual Durable Object records rather than silently dropping older entries from a fixed-size array. Reconnects receive a bounded page plus live deltas, with earlier pages available on demand. Byte admission and batch sizes come from the documented platform contract in [platform policy](./docs/platform-policy.md), not scattered UI magic numbers. Repository intent and progress remain in the Durable Object work ledger, per-item operator turn records, GitHub issues and pull requests, commits, and checked-in documentation.

The end-to-end path, trust boundaries, stack behavior, and current limitations are described in [the architecture guide](./docs/architecture.md).
