# How it works today

```text
Browser clients ↔ App Harness Worker ↔ one ChatRoom Durable Object per room
                                         │
                                         ├─ public request + lifecycle ledger
                                         ├─ GitHub App issue
                                         └─ service-binding RPC
                                              ↓
                                  one persistent Cloudflare OS workspace/chat
                                              │
                                              └─ typed APP_HARNESS capability
                                                   ↓
                                  durable stack coordinator → Sandbox runner
                                                   ↓
                                  branch/PR → CI → merge → deploy → callback
```

The Worker serves the app and routes each room to a Durable Object. That object owns chat WebSockets, the sanitized target envelope, work items, external artifact links, leases, retries, and the lifecycle shown to connected clients.

Every text request first creates a real GitHub issue through the App Harness GitHub App. The Durable Object then submits one idempotent external message over a private service binding to the Cloudflare OS `ExternalMessageGateway`. The repository name selects one persistent workspace and `repository-main` selects one persistent chat; the work-item UUID is the message key. Repeating the handoff cannot create a second OS turn.

Cloudflare OS owns the long-lived operator context. Its final text is delivered through a persistent `ctx.restore()` callback created by the original room and correlated to the work item. That response is recorded publicly, but it is never parsed as authorization.

The operator can start implementation only through the typed ambient `APP_HARNESS.enqueueRepositoryTask({ workItemId, issueNumber })` capability. That capability carries no repository, prompt, source, shell command, or credential. The App Harness Worker checks the two identifiers against its original durable record, then idempotently queues the existing deterministic sequence: observe `main`, start the isolated native-Git runner, verify the branch/PR and immutable SHAs, dispatch CI/promotion, merge, deploy, and accept only signed completion evidence.

The Sandbox child is ephemeral per bounded implementation task. NanoCodex defaults to GPT-5.6 Luna with low reasoning, web search off, and read-only parallel subagents enabled for investigation and test diagnosis. The parent child-agent alone edits and owns Git/stack operations. The persistent Cloudflare OS workspace—not the child process—retains repository-level conversation and orchestrator context.

Target mode enriches the request with a server-sanitized `data-target-id` envelope. Text comments use the same autonomous path. Drawing vectors are public visual context and receive a GitHub issue, but require a text request before implementation begins.

The UI may say **issue created**, **workspace accepted**, **building**, **PR opened**, **validating**, **deployed**, or **needs review** only after the matching durable or external event exists. Source code is not production proof: the complete path is live only after the Workshop/Gatekeeper and App Harness changes are deployed and a fresh request produces the issue, OS turn, PR, CI run, merge, deployment, and callback.
