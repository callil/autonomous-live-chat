# Superseded NanoCodex candidate experiment

This earlier GitHub Actions/NanoCodex proposal is no longer the primary architecture. It was never deployed as a model-driven production path. App Harness is pivoting to [Cloudflare OS](./cloudflare-os-provider.md), where capability-scoped Gatekeepers, isolated Sandbox workspaces, and the Durable Object ledger form the intended substrate.

The prior intended boundary was:

1. The Durable Object remains the authoritative room policy, queue, and public ledger.
2. A GitHub Actions job checks out an isolated candidate workspace for exactly this repository.
3. NanoCodex would have received the scoped request in a candidate workspace without GitHub or Cloudflare credentials.
4. A deterministic post-agent verifier would have compared the workspace to its fixed base revision.
5. The runner reports structured lifecycle events back to the Durable Object for all connected clients.

The deterministic transformer remains a safe fallback for its tiny accent/copy allowlist. It is not a coding agent.

## Credential prerequisite

No NanoCodex workflow is enabled. Any future agent provider must use securely stored model credentials and must never pass them through chat or browser code.

The next expansion must keep the current prohibitions, use the [stacked-PR scheduler](./stacked-prs.md), and introduce repository access through a narrow GitHub Gatekeeper capability rather than ambient Actions credentials.
