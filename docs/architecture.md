# Architecture

## Four code surfaces

| Surface | Owns | Does not own |
| --- | --- | --- |
| `apps/demo` | Chat UI, room protocol, Worker routes, Durable Object state, product deployment | Reusable React API or isolated Git credentials |
| `packages/contracts` | Provider-derived limits, delivery policy, sanitized authoring-envelope schema | Product behavior, presentation, or deployment orchestration |
| `packages/react` | Summonable launcher, element targeting, sanitized target envelope, pluggable submission callback | Chat storage, GitHub, Cloudflare, or agent policy |
| `infra` | Provider contracts, durable stack rules, trusted checks, operator Worker, Sandbox runner, GitHub bridge | Host-app presentation or product features |

The current demo uses a small framework-free browser client, so it does not consume the React package. Both implement the same target-envelope contract. This is intentional: the package proves the integration boundary for React hosts, while the demo stays fast and understandable.

## Runtime flow

```mermaid
flowchart LR
    User["User targets the live app"] --> Room["Demo Durable Object ledger"]
    Room -- "fire-and-forget poke" --> Gateway["Operator Worker gateway"]
    Gateway --> Turn["Per-item OperatorTurn Durable Object"]
    Turn -- "snapshot read + typed ledger RPC" --> Room
    Turn --> GitHub["Private GitHub App capability"]
    GitHub --> Issue["Issue + public status"]
    Turn --> Runner["Disposable Cloudflare Sandbox job"]
    Runner --> GitHub
    GitHub --> Git["Short-lived repository credential"]
    Runner -- "completion + live progress callbacks" --> Room
    Runner --> Stack["PR or dependent PR stack"]
    Stack --> CI["Profile-aware CI"]
    CI --> Promote["Serialized promotion + deploy"]
```

The Durable Object is the workflow ledger and realtime broadcaster. It records truth and emits events: whenever it persists a state change relevant to a live work item — a submission, a pushed external fact, a phase transition from an operator action — it fires one fire-and-forget poke at the operator worker. There are no work-item leases, no wake records, no delivery attempts, and no paced redelivery loop: the per-item `OperatorTurn` Durable Object is already serialized, and the ledger's phase guards plus semantic idempotency keys are the correctness guarantee for whatever it stages. The ledger keeps exactly one alarm: a slow five-minute sweep that recovers interrupted action executions and re-pokes every live item, so a lost poke costs minutes, never the item. A lifetime budget of 200 pokes per item parks a non-converging item to `needs_review`.

The operator is a plain Cloudflare Worker (`infra/workers/operator`). The `OperatorGateway` entrypoint routes each poke to one `OperatorTurn` Durable Object per work item, which owns its own lifecycle: it reads a fresh authoritative ledger snapshot at the start of every turn, then runs one bounded model loop — a compact system prompt, strict constrained-decoding tool schemas, hard tool-call and token caps, and adaptive time budgeting: each model call (45s) and tool call (30s observation, 120s stage) carries its own timeout, and the loop only starts a call that still fits inside a generous ten-minute turn envelope. A poke that arrives mid-turn marks the object; the finished turn starts the next one with a fresh snapshot. A turn that ends `WAITING` re-drives itself with its own 60-second alarm — no ledger involvement. Every write goes through the ledger's stage/begin/execute/complete action protocol, so an interrupted turn replays the identical command instead of double-executing. Its private capabilities are service bindings back to the demo's `LedgerService`, to the Sandbox coding runner, and to the GitHub App bridge.

The Sandbox coding process is disposable and observable live: while the coding agent runs, its JSONL events stream to the ledger callback in small bounded batches (ten events or five seconds, whichever first). The ledger keeps a rolling last-30 tail under the item's `runnerProgress` fact, the public activity feed gets a human line only on step transitions (cloned, agent started, agent done, pushed), and the operator snapshot embeds a bounded tail so the model sees what the agent last did. The terminal artifact arrives through the same job-bound callback, lands as a typed runner fact, and pokes the operator. Durable records and independently verifiable Git artifacts make retries safe when a model, container, Worker, GitHub Actions, or upstream API is interrupted.

## GitHub identity

The runner does not receive the GitHub App private key. A dedicated bridge validates a short-lived, job-bound assertion and mints a repository installation credential for the specific Git process. This limits the damage of a leaked child process without limiting what a legitimate coding task may change inside the repository.

GitHub comments currently appear as the installed GitHub App or automation identity configured for the bridge. They should not be attributed to the human requester once all writes use that path.

## Stacks

The unit of scheduling is a stack, not an independent pull request. Each node records its parent, expected base SHA, generation, head SHA, checks, and promotion state. Only the current bottom eligible node can promote. Descendants wait for their parent and are restacked against the resulting base before validation.

This model prevents the old failure mode where several autonomous PRs race `main`, repeatedly become stale, rebase, and invalidate one another. A single coherent change remains a one-node stack.

The durable ledger and runner contract model dependent nodes, but the current trusted GitHub validation and promotion workflows deliberately fail closed on anything other than the one-node path. Native multi-node stack submission and ordered promotion are therefore not yet end-to-end. They must not be described as operational until the trusted gate verifies GitHub stack identity, order, and target-base metadata for every node.

## Data boundaries

The demo does not invent character-count or record-count product limits. Messages, annotations, and work items use individual Durable Object records so history is not silently discarded to protect one oversized array value. Monotonic room sequences preserve ordering, reconnects load one page, live changes broadcast as deltas, and earlier pages remain available on demand. Cloudflare's documented storage and WebSocket limits remain the actual runtime boundary; GitHub receives a transport-safe representation with a durable work-item reference when necessary. See [platform policy](./platform-policy.md). Agent memory is separate: per-item operator turn transcripts, durable work items, GitHub issues/PRs, commits, and repository docs preserve the implementation history.

Target envelopes contain stable IDs, tag/role, an explicit safe label or marked static text, same-origin path, and viewport rectangle. They do not contain form values, message bodies, query strings, credentials, or arbitrary DOM serialization.

## Deployed services

| Service | Purpose |
| --- | --- |
| `autonomous-live-chat` | Demo Worker, assets, and room Durable Objects |
| `app-harness-operator` | Operator Worker: wake gateway and per-item turn Durable Objects |
| `app-harness-os-native-git` | Isolated Sandbox coding runner |
| `app-harness-os-git-proxy` | Repository credential and GitHub status bridge |

Every deployed service is versioned in this repository: the demo under `apps/demo`, the other three under `infra/workers`. The `app-harness-os-*` names are historical; the runner and bridge predate the current operator and keep their deployed identities.
