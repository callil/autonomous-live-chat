# Cloudflare OS provider

App Harness is deliberately pluggable at four narrow seams: intake/provenance, workspace executor, source-control promotion, and audit/status events. The UI and Durable Object ledger speak those seams; they do not assume a particular coding model or CI vendor.

The default planned provider is Cloudflare OS v2, pinned for this assessment at upstream commit `e1ab8fbd4f609aff7ede9d490bafe1bcf9b2a682` (2026-08-05). It supplies the capability model: a workspace is a Durable Object, resources are introduced explicitly, and Gatekeepers narrowly scope and log external actions. The GitHub Gatekeeper supports a selected repository, issue, or PR through user OAuth; it does not grant ambient organization access.

The execution half uses the Cloudflare Sandbox SDK, which is a real isolated Linux container. Its documented `gitCheckout()` plus native `git` commands can clone, branch, inspect, test, commit, and push a candidate workspace. A production provider must inject Git credentials only through a Gatekeeper/proxy with a short-lived, repository-scoped capability—never by placing a broad token in the sandbox.

## Current truthful boundary

The repository now defines a NanoCodex 0.3.0 runner image on Cloudflare Sandbox 0.12.4, using the current `gpt-5.6-sol` default. A bounded text request creates a `cloudflare-os-planning` GitHub issue and reaches the planner. Approved `repository-task` plans may cover source, tests, workflows, configuration, migrations, and infrastructure; the planner still rejects ambiguous, credential-seeking, harmful, or unsupported work. The Durable Object stores only the bounded request and model provenance, then uses its at-least-once alarm to start or resume the isolated job.

Inside the Sandbox, NanoCodex receives a full repository checkout and normal coding tools: terminal, filesystem, Git, GitHub CLI, the official `gh stack` extension, package/test/build tools, migration tools, and Wrangler. Safety comes from explicit operating guidance, ephemeral repository-scoped credentials, an output wrapper that discards transcript and arguments, immutable Git/PR provenance, and mandatory unprivileged CI—not a file or command allowlist. NanoCodex must leave a clean tree, pushed commits, and an open PR at the expected head. The runner independently verifies those artifacts and persists only model ID, bounded Responses IDs, tool names, SHAs, and the PR URL.

NanoCodex runs as a Cloudflare Sandbox background process, not as one long synchronous `exec()` request. The runner polls its bounded process record, emits minute-level progress telemetry, reads only the final redacted result, and terminates it after twelve minutes. This avoids the Sandbox SDK transport timeout for long non-streaming commands while keeping the whole attempt inside the Durable Object alarm's fifteen-minute wall-time limit.

The durable coordinator currently promotes one root PR per work item. NanoCodex has the native `gh stack init/add/submit --auto --open` toolchain for genuinely dependent slices, but multi-node promotion remains fail-closed until every native Stack edge is represented and verified in the durable ledger.

These source changes are not evidence that the new image is deployed or that a model-driven PR succeeded. No branch, commit, push, pull request, CI result, promotion, or deployment is claimed until those external artifacts exist. A missing binding, failed plan, changed stack base, dirty checkout, unpushed head, absent PR, or runner failure becomes a truthful **needs review** state. Cloudflare OS’s official deployment starter additionally requires the account’s Dynamic Worker Loaders, Browser Rendering, KV/R2, and a Cloudflare Access identity configuration. Workshop sign-in may use Cloudflare's native identity/account-member policy; GitHub is **not** a Workshop sign-in prerequisite.

When those capabilities are connected, the provider receives only the sanitized target/provenance envelope, root issue URL, allowed repository resource, and bounded change policy. Its audit adapter writes every capability use, native command summary, branch/PR edge, CI result, and promotion event back to the room Durable Object.

See [stacked PR scheduling](./stacked-prs.md) for the required branch graph and [current policy](./current-autonomy-and-policy.md) for the fallback boundary.
