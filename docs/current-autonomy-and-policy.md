# Current autonomy and policy

App Harness uses a full repository coding agent, not a fixed transform, file allowlist, or color-only agent. A normal text request enters the persistent Cloudflare OS workspace after its public GitHub issue exists. The workspace may autonomously delegate a bounded implementation job to the isolated Sandbox runner.

Inside that Sandbox, NanoCodex has the checked-out repository and ordinary filesystem, terminal, Git, GitHub CLI, stack, package, test, migration, and Wrangler tools. It can change frontend, backend, data models, tests, workflows, and Cloudflare-platform configuration when the request requires them. CI—not an artificial command allowlist—is the merge and deployment authority.

Safety is layered:

- The persistent operator follows explicit guidelines to refuse illegal, harmful, offensive, credential-seeking, intentionally availability-destroying, destructive-data, or unsupported external-infrastructure requests.
- The OS Gatekeeper exposes one typed App Harness capability. Agent prose cannot select another repository or replace the original durable request.
- The GitHub App and short-lived installation credentials are repository-scoped and process-scoped. The Sandbox never receives the App private key.
- Candidate code runs in unprivileged CI. Immutable base/head provenance, stack generation, merge checks, and signed deployment callbacks are required before completion is recorded.
- Existing user data, credentials, and unrelated work must be preserved. Irreversible data deletion is a human boundary.

These are operating and capability boundaries, not a narrow catalog of permitted product changes. The agent is expected to act autonomously when it can complete the work safely and truthfully. If it cannot, it records the refusal or blocker publicly rather than inventing a branch, check, or deployment.

Target metadata improves situated understanding without widening authority. Inputs, chat bodies, query strings, secrets, and credentials are excluded from the target envelope. The original durable request and issue remain authoritative throughout execution.
