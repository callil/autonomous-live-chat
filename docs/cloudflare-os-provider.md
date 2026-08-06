# Cloudflare OS provider

App Harness is deliberately pluggable at four narrow seams: intake/provenance, workspace executor, source-control promotion, and audit/status events. The UI and Durable Object ledger speak those seams; they do not assume a particular coding model or CI vendor.

The default planned provider is Cloudflare OS v2, pinned for this assessment at upstream commit `e1ab8fbd4f609aff7ede9d490bafe1bcf9b2a682` (2026-08-05). It supplies the capability model: a workspace is a Durable Object, resources are introduced explicitly, and Gatekeepers narrowly scope and log external actions. The GitHub Gatekeeper supports a selected repository, issue, or PR through user OAuth; it does not grant ambient organization access.

The execution half uses the Cloudflare Sandbox SDK, which is a real isolated Linux container. Its documented `gitCheckout()` plus native `git` commands can clone, branch, inspect, test, commit, and push a candidate workspace. A production provider must inject Git credentials only through a Gatekeeper/proxy with a short-lived, repository-scoped capability—never by placing a broad token in the sandbox.

## Current truthful boundary

The isolated runner is deployed at `app-harness-os-native-git` and has passed a remote Cloudflare Sandbox `git --version` probe. App Harness now has a private service-binding seam that turns an eligible, issue-backed work item into a bounded job ID, repository, room, stack generation, and audit record. It persists whether that runner reports a checkout, credential block, checkout failure, or an unknown response; it never treats a request as native Git execution merely because it was queued.

The live provider remains disabled by default. A missing runner binding or runner credential creates a truthful **needs review** state; the configured runner is also fail-closed until the default-deny [GitHub App credential bridge](./native-git-credential-bridge.md) is installed. No model-driven sandbox agent, native clone, branch, commit, push, PR, CI, or deployment is claimed yet. Cloudflare OS’s official deployment starter additionally requires the account’s Dynamic Worker Loaders, Browser Rendering, KV/R2, and a Cloudflare Access identity configuration. Workshop sign-in may use Cloudflare's native identity/account-member policy; GitHub is **not** a Workshop sign-in prerequisite.

When those capabilities are connected, the provider receives only the sanitized target/provenance envelope, root issue URL, allowed repository resource, and bounded change policy. Its audit adapter writes every capability use, native command summary, branch/PR edge, CI result, and promotion event back to the room Durable Object.

See [stacked PR scheduling](./stacked-prs.md) for the required branch graph and [current policy](./current-autonomy-and-policy.md) for the fallback boundary.
