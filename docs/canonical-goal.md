# Canonical goal: a live, self-evolving App Harness

App Harness is a minimal chat application with one optional contextual authoring launcher. It turns a selected element, comment, or drawing into a durable, shared change request without turning the product into a dashboard.

## Non-negotiable autonomy contract

The operator is a full autonomous software agent, not a color changer, documentation agent, fixed patch generator, or command allowlist. Inside a fresh isolated Cloudflare Sandbox it receives the repository workspace and a real terminal. It may inspect and edit the entire application, write tests, make safe database and Cloudflare-platform changes, run builds and migrations, use Git and GitHub's native stacked-PR commands, respond to failures, merge validated work, and deploy without waiting for a human approval step.

Safety is expressed through the agent's operating guidelines, public intent and action records, short-lived process-scoped credentials, isolated execution, CI, reversible releases, and truthful refusal. It is not implemented by artificially removing ordinary coding capabilities. The operator must preserve user data and secrets and refuse illegal, harmful, offensive, intentionally availability-destroying, or externally unsupported work; otherwise it should act autonomously and finish the loop.

Cloudflare OS is the persistent coding operator and keeps repository-level conversation and context. NanoCodex is its ephemeral implementation child inside the isolated Sandbox; it is spawned per bounded task and may use read-only parallel subagents for investigation, while its parent alone edits and owns the stack.

## Acceptance criteria

1. The normal view is clean chat. Target/comment/draw authoring is summoned from one small launcher, acknowledges submission immediately, and exposes only truthful activity on demand.
2. The per-room Durable Object persists and broadcasts the safe target/provenance envelope, work item, issue/PR URLs, and lifecycle events to every connected client.
3. Eligible work enters a real isolated Cloudflare OS/Sandbox workspace. A pinned NanoCodex launcher receives the checked-out repository plus full native filesystem, terminal, Git, and GitHub stack capabilities for that isolated job.
4. Every request creates a real GitHub issue. The workspace creates a native Git branch and PR. Tiny independent changes use one PR; related dependent changes use an ordered GitHub PR stack.
5. A stack has one root `main` base SHA, ordered parent branches, a generation, and one CI concurrency key. A main advance produces `needs-restack`; only the root restacks onto main, then descendants regenerate from their parent. A failed or closed lower PR blocks descendants. No PR independently auto-rebases onto main.
6. CI and Cloudflare deployment are independent gates. Only their authenticated events can mark validation, deployment, or completion.
7. The app exposes actual GitHub and deployment links/states and never claims an agent ran when it did not.
8. A controlled policy-approved request reaches production with evidence: GitHub issue, PR/stack, CI run, deployment, and visible live change.

## Provider contract

Cloudflare OS is the preferred orchestration and governance provider. The Workshop uses Cloudflare Access with a native Cloudflare identity/account-member policy; GitHub is not required for Workshop sign-in. Its GitHub Gatekeeper separately introduces the repository resource, and a Sandbox workspace uses short-lived process-scoped credentials to run NanoCodex with the full repository terminal. The Durable Object is the authoritative App Harness ledger—not the coding agent—and receives bounded, secret-free audit events for agent progress and external artifacts.

GitHub Actions remains the deterministic validation, promotion, and deployment gate. It is not a second planner or a fixed source transformer.
