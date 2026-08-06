# App Harness

App Harness is a deliberately small reference harness for situated, auditable changes to live software. This repository uses a multi-user chat application to prove the full loop. A Cloudflare Worker serves the interface and routes each room to one Durable Object. The Durable Object persists the latest 200 messages and broadcasts new messages to every connected WebSocket client.

Contributor documentation lives in [docs/README.md](./docs/README.md).

The deployed Worker and GitHub repository retain the historical `autonomous-live-chat` infrastructure names for now. The product and integration surface are App Harness.

## Run it

```sh
npm install
npm run dev
```

Open the local URL in two browser windows and send a message from either one. They share the `main` room in real time.

## Deploy it

```sh
npm run deploy
```

## Autonomous change loop

For situated feedback, open the small **App Harness** button at the lower-right, choose **Target**, click a visible element, and describe a change in the compact bottom composer. The room's Durable Object durably stores the request and its public activity record, then broadcasts each transition to every connected client. The authoring surface stays out of the way until it is summoned.

Targeted requests include a sanitized, stable envelope based on an explicit `data-target-id`. It contains the element identity, semantic tag/role, a safe label or explicitly marked static text, page and room context, and its viewport rectangle. Input values, message bodies, query strings, and secrets are not included. See [targeting and integration](./docs/targeting.md).

The optional App Harness overlay frames the host app rather than becoming permanent chrome. It stays collapsed when not in use and supports target-aware requests, durable comments, and freehand context; see [overlay canvas](./docs/overlay-canvas.md). Every submission creates a durable activity item and a real GitHub issue. The on-demand Activity list exposes actual issue and pull-request URLs.

Every text request then goes directly, over a private Cloudflare service binding, to one persistent Cloudflare OS workspace/chat for this repository. There is no separate stateless planner. Cloudflare OS keeps the long-lived operator context and can delegate implementation through one typed App Harness capability containing only the durable work-item ID and issue number.

The capability resumes the existing durable pipeline from the original request: observe `main`, start an isolated Cloudflare Sandbox, run an ephemeral NanoCodex coding child with the full checkout and normal engineering tools, create a PR or ordered PR stack, run unprivileged CI, merge, deploy, and reconcile a signed callback. Ordinary children default to GPT-5.6 Luna with low reasoning and can use parallel read-only subagents for investigation; the child parent alone edits and owns Git/stack operations.

Safety comes from operating guidelines, isolated execution, process-scoped repository credentials, immutable Git provenance, CI, reversible deployment, and truthful refusal—not a color/copy or command allowlist. The agent can change the full application when it can do so safely. It must preserve data and secrets and refuse illegal, harmful, intentionally availability-destroying, destructive-data, credential-seeking, or externally unsupported work.

The room transcript keeps the latest 200 chat messages as a bounded product snapshot. That cap is not the agent’s memory: the persistent Cloudflare OS workspace owns operator context, while GitHub issues, PRs, repository files, and the durable work ledger preserve the implementation record.

See [how it works](./docs/how-it-works-today.md), the [Cloudflare OS provider](./docs/cloudflare-os-provider.md), and the [stacked-PR scheduler](./docs/stacked-prs.md).
