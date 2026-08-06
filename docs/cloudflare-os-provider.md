# Cloudflare OS provider

Cloudflare OS is the persistent operator for App Harness. One repository maps to one OS workspace and one long-lived chat. That workspace retains the operator conversation and organization/repository context across requests; implementation children are disposable.

## Direct workspace handoff

After creating the public issue, the room Durable Object calls the deployed OS Worker over a private service-binding RPC to `ExternalMessageGateway`. The submission uses fixed keys:

- workspace: `callil/autonomous-live-chat`
- chat: `repository-main`
- message idempotency/correlation: the durable App Harness work-item UUID
- caller: the configured Access account
- callback: a persistent `ctx.restore()` stub created by the existing room and bound to the work item

There is no stateless planner Worker, callback Worker, or second bearer secret between App Harness and OS. The service binding carries the RPC capability. The room implements Cloudflare's `[restore]` hook, so either Worker can restart before OS invokes the callback. OS retries the response target at least once; App Harness validates its work-item correlation, deduplicates the final text, and records it as public commentary only.

## Execution capability

The custom OS Gatekeeper introduces one ambient capability:

```ts
APP_HARNESS.enqueueRepositoryTask({ workItemId, issueNumber })
```

It invokes the App Harness Worker’s exported `OsExecutionBridge` over a service binding. The bridge has no HTTP route and accepts no repository name, request text, source, command, token, or model output. It resolves the original work item and issue from the ChatRoom Durable Object, rejects mismatches, and creates one idempotent `observe-main` outbox effect.

From there deterministic code owns the state machine: observe the current base, create the durable stack ledger, run the isolated Cloudflare Sandbox child, verify the pushed branch and PR, dispatch CI/promotion, merge, deploy, and reconcile signed callbacks.

## Coding child

NanoCodex 0.3 is an ephemeral coding child, not the central orchestrator. Ordinary work defaults to `gpt-5.6-luna` with low reasoning; web search is disabled unless a later explicit policy adds a researched task path. Built-in read-only subagents are enabled for parallel inspection, review, and test diagnosis. The parent child-agent alone edits and owns Git and GitHub stack operations. GPT-5.6 Sol is reserved for an explicit escalation rather than paid on every request.

The child receives the full checkout and normal engineering tools. Its output wrapper retains only bounded provenance (model, response IDs, tool names) plus independently verified Git/GitHub artifacts. Transcripts, tool arguments, diffs, credentials, and shell output are not copied into the public ledger.

## Truth boundary

The source tree defines this path, but source is not deployment evidence. A production claim requires compatible Workshop/Gatekeeper and App Harness Worker versions plus one fresh artifact chain: issue → accepted OS turn → capability call → branch/PR or ordered stack → CI → merge → Cloudflare deployment → signed callback → visible result.

See [stacked PR scheduling](./stacked-prs.md), [credential bridge](./native-git-credential-bridge.md), and [current policy](./current-autonomy-and-policy.md).
