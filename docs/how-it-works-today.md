# How it works today

```text
Browser clients ↔ Worker ↔ one Durable Object per room
                              │
                              └─ request ledger + WebSocket broadcasts
                                      │
                                      └─ GitHub issue handoff
                                             ├─ guarded GitHub Actions fallback (eligible requests only)
                                             ├─ candidate branch + pull request
                                             ├─ Cloudflare/type checks
                                             ├─ policy-approved promotion
                                             └─ Wrangler production deployment
```

The Cloudflare Worker serves the app and routes each room name to a dedicated Durable Object. The object owns the room transcript, connected WebSockets, change-request record, and ordered public lifecycle events. New or already-connected clients receive the same durable status record in real time.

App Harness's optional target mode adds a small, sanitized element envelope to that same record. It derives a stable selector from an explicit `data-target-id`, preserves tag/role, safe label or marked static text, page/room, and viewport rectangle, and never persists form values or message contents. Comments and drawings also create durable shared intake items, whose **Activity** state remains available after reconnect. Every intake item is handed to GitHub as an external issue containing that safe envelope, its App Harness work-item ID, policy classification, and a live-room link. The in-app Activity list shows the actual issue (and, when applicable, pull request) URL. See [Targeting and integration](./targeting.md).

For a policy-approved fallback request, the object dispatches an isolated GitHub Actions run after the issue exists. That run creates a candidate branch and pull request, runs `npm run cf-typegen` and `npx tsc --noEmit`, promotes only the policy-approved result, and deploys through Wrangler. It comments the issue with candidate and deployment status; authenticated callbacks append matching durable activity events such as **received**, **interpreting**, **preparing candidate**, **validating**, **deploying**, and **completed**. Out-of-policy requests have an issue but remain **awaiting coding-agent triage**; they never claim that this runner or a model-driven agent started.

The Durable Object is a coordinator and ledger, not an AI agent. It orders state, applies policy, and makes activity visible. The current fallback runner is deterministic; it does not reason about the codebase or invent an implementation.
