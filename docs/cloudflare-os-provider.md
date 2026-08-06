# Cloudflare OS provider

App Harness is deliberately pluggable at four narrow seams: intake/provenance, workspace executor, source-control promotion, and audit/status events. The UI and Durable Object ledger speak those seams; they do not assume a particular coding model or CI vendor.

The default planned provider is Cloudflare OS v2, pinned for this assessment at upstream commit `e1ab8fbd4f609aff7ede9d490bafe1bcf9b2a682` (2026-08-05). It supplies the capability model: a workspace is a Durable Object, resources are introduced explicitly, and Gatekeepers narrowly scope and log external actions. The GitHub Gatekeeper supports a selected repository, issue, or PR through user OAuth; it does not grant ambient organization access.

The execution half uses the Cloudflare Sandbox SDK, which is a real isolated Linux container. Its documented `gitCheckout()` plus native `git` commands can clone, branch, inspect, test, commit, and push a candidate workspace. A production provider must inject Git credentials only through a Gatekeeper/proxy with a short-lived, repository-scoped capability—never by placing a broad token in the sandbox.

## Current truthful boundary

The isolated runner is deployed at `app-harness-os-native-git` and has passed remote Cloudflare Sandbox probes plus a repository-scoped native checkout. App Harness has private service bindings to a GPT-5.6 Terra planning Worker and the runner. A bounded text request first creates an `cloudflare-os-planning` GitHub issue, then reaches the planner; only a schema-validated unified patch limited to `README.md` and `docs/*.md` is forwarded to the runner. The Durable Object persists the plan and model provenance, then uses its single at-least-once alarm to start or resume the runner job. The runner receives the plan, stack generation, issue number, and allowed repository—not raw user prose or a model response.

The runner writes that patch into its isolated checkout, applies it with `git apply --whitespace=error-all`, runs `git diff --check`, proves the changed path list stays in the documentation allowlist, then stages only `README.md` and `docs/`, commits, pushes, and opens a PR. A malformed patch, a non-documentation path, an empty diff, or a failed check terminates the candidate without a PR claim.

This is deliberately one candidate / one PR. A future multi-node request is fail-closed until a separate trusted Stack Submitter completes native `gh stack init` / `submit --auto` and verifies the returned GitHub Stack REST object; chained PR bases alone never count as a native Stack.

The model-planning and checkout pieces are live, but no branch, commit, push, pull request, CI result, promotion, or deployment is claimed until those external artifacts exist. The candidate branch and PR operation are idempotent for a single durable stack job: a retry addresses only its derived branch and reuses an existing open PR. A missing binding, failed plan, changed stack base, or runner failure becomes a truthful **needs review** state. Cloudflare OS’s official deployment starter additionally requires the account’s Dynamic Worker Loaders, Browser Rendering, KV/R2, and a Cloudflare Access identity configuration. Workshop sign-in may use Cloudflare's native identity/account-member policy; GitHub is **not** a Workshop sign-in prerequisite.

When those capabilities are connected, the provider receives only the sanitized target/provenance envelope, root issue URL, allowed repository resource, and bounded change policy. Its audit adapter writes every capability use, native command summary, branch/PR edge, CI result, and promotion event back to the room Durable Object.

See [stacked PR scheduling](./stacked-prs.md) for the required branch graph and [current policy](./current-autonomy-and-policy.md) for the fallback boundary.
