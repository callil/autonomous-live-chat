# App Harness

App Harness is a small, real demonstration of software that can receive situated feedback, turn it into repository work, validate that work as an ordered stack, and update itself in public.

The host product is intentionally simple: a live multi-user chat backed by a Cloudflare Worker and one Durable Object per room. A summonable overlay lets someone point at the interface and describe a change. The durable coordinator publishes the request to GitHub and hands eligible implementation work to a persistent Cloudflare OS operator and an isolated coding runner.

- Live demo: [autonomous-live-chat.coda-a.workers.dev](https://autonomous-live-chat.coda-a.workers.dev)
- Operator: [app-harness-os.coda-a.workers.dev](https://app-harness-os.coda-a.workers.dev)
- Documentation: [docs/README.md](./docs/README.md)

## Repository map

```text
apps/demo/                 live chat frontend + Worker/Durable Object backend
packages/react/            reusable React authoring overlay
infra/orchestration/       durable job, stack, and provider contracts
infra/workers/             isolated coding runner + GitHub credential bridge
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

The room stores the latest 200 chat messages as a bounded product transcript. That is not the coding agent's memory limit. Repository intent and progress remain in the Durable Object work ledger, Cloudflare OS workspace, GitHub issues and pull requests, commits, and checked-in documentation.

The end-to-end path, trust boundaries, stack behavior, and current limitations are described in [the architecture guide](./docs/architecture.md).
