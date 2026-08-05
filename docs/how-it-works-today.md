# How it works today

```text
Browser clients ↔ Worker ↔ one Durable Object per room
                              │
                              └─ request ledger + WebSocket broadcasts
                                      │
                                      └─ guarded GitHub Actions runner
                                             ├─ candidate branch + pull request
                                             ├─ Cloudflare/type checks
                                             ├─ policy-approved promotion
                                             └─ Wrangler production deployment
```

The Cloudflare Worker serves the app and routes each room name to a dedicated Durable Object. The object owns the room transcript, connected WebSockets, change-request record, and ordered public lifecycle events. New or already-connected clients receive the same durable status record in real time.

For a policy-approved fallback request, the object dispatches an isolated GitHub Actions run. That run creates a candidate branch and pull request, runs `npm run cf-typegen` and `npx tsc --noEmit`, promotes only the policy-approved result, and deploys through Wrangler. Authenticated callbacks append durable activity events such as **received**, **interpreting**, **preparing candidate**, **validating**, **deploying**, and **completed**.

The Durable Object is a coordinator and ledger, not an AI agent. It orders state, applies policy, and makes activity visible. The current fallback runner is deterministic; it does not reason about the codebase or invent an implementation.
