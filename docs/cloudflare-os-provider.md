# Cloudflare OS provider

App Harness is deliberately pluggable at four narrow seams: intake/provenance, workspace executor, source-control promotion, and audit/status events. The UI and Durable Object ledger speak those seams; they do not assume a particular coding model or CI vendor.

The default planned provider is Cloudflare OS v2, pinned for this assessment at upstream commit `e1ab8fbd4f609aff7ede9d490bafe1bcf9b2a682` (2026-08-05). It supplies the capability model: a workspace is a Durable Object, resources are introduced explicitly, and Gatekeepers narrowly scope and log external actions. The GitHub Gatekeeper supports a selected repository, issue, or PR through user OAuth; it does not grant ambient organization access.

The execution half uses the Cloudflare Sandbox SDK, which is a real isolated Linux container. Its documented `gitCheckout()` plus native `git` commands can clone, branch, inspect, test, commit, and push a candidate workspace. A production provider must inject Git credentials only through a Gatekeeper/proxy with a short-lived, repository-scoped capability—never by placing a broad token in the sandbox.

## Current truthful boundary

The deployed chat application still uses its narrow deterministic GitHub Actions fallback. No Cloudflare OS workspace has been deployed or attached yet, and no model-driven sandbox agent is claimed as live. Cloudflare OS’s official deployment starter additionally requires the account’s Dynamic Worker Loaders, Browser Rendering, KV/R2, and a Cloudflare Access identity configuration. Workshop sign-in may use Cloudflare's native identity/account-member policy; GitHub is **not** a Workshop sign-in prerequisite. GitHub OAuth client credentials are needed later and separately for the GitHub Gatekeeper repository capability. These are separate infrastructure capabilities, not something the live chat worker can silently invent.

When those capabilities are connected, the provider receives only the sanitized target/provenance envelope, root issue URL, allowed repository resource, and bounded change policy. Its audit adapter writes every capability use, native command summary, branch/PR edge, CI result, and promotion event back to the room Durable Object.

See [stacked PR scheduling](./stacked-prs.md) for the required branch graph and [current policy](./current-autonomy-and-policy.md) for the fallback boundary.
