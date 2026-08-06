# Native Git credential bridge

The deployed `app-harness-os-native-git` Worker proves that Cloudflare Sandbox can run an isolated shell. Native checkout and push remain disabled until this bridge is configured; the runner returns `credential-bridge-required` rather than simulating a clone.

## Enforced shape

`app-harness-os-native-git` creates a five-minute HMAC assertion bound to the job ID, repository, and stack generation. The Sandbox uses that assertion only as a Git smart-HTTP header. `app-harness-os-git-proxy` validates it, accepts only Git upload/receive endpoints for `callil/autonomous-live-chat`, then creates a short-lived GitHub App installation token for the outgoing GitHub request. The Sandbox never receives a GitHub token or GitHub App private key.

The proxy is default-deny: every other repository, expired or malformed assertion, path outside Git smart HTTP, method outside GET/POST, and absent GitHub App configuration fails closed. The runner also accepts no raw command, branch, repository, or shell input from an authoring request.

## Exact GitHub App gate

Create a new GitHub App under **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**. It must be installed on **only** `callil/autonomous-live-chat`, with repository permissions:

- **Contents: Read and write**
- **Pull requests: Read and write**
- **Issues: Read and write**
- **Metadata: Read-only**

Disable webhooks. The app does not need an OAuth callback. Generate one private key and record the App ID and installation ID. Store only these GitHub repository secrets—never in source, Worker vars, or the Sandbox:

- `APP_HARNESS_GITHUB_APP_ID`
- `APP_HARNESS_GITHUB_APP_INSTALLATION_ID`
- `APP_HARNESS_GITHUB_APP_PRIVATE_KEY`
- `GIT_PROXY_ASSERTION_SECRET` (one high-entropy secret shared only by runner and proxy)

The proxy deployment workflow maps those repository-secret names to its internal Worker secrets `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY`; they never appear in source or the Sandbox. The runner deployment workflow installs only `GIT_PROXY_ASSERTION_SECRET` in addition to its existing caller secret. After the proxy is deployed with those values, a reviewed configuration change may set `NATIVE_GIT_ENABLED` to `true`; until then no clone, branch, commit, push, PR, CI, or deploy action can run through this path.

## Durable audit contract

App Harness records only bounded events: job prepared, capability requested, sandbox created, checkout started/finished, allowlisted command started/finished, branch/PR updated, CI reported, deployment reported, or job blocked. Each includes work item, stack generation, and command ID or external URL where relevant—never stdout, source, prompt, OAuth token, App key, or the assertion itself. See [`src/os-native-git-preflight.js`](../src/os-native-git-preflight.js).

## GitHub App identity bridge

The same proxy now has a second, deliberately narrow capability: authenticated issue/status writes for the exact allowlisted repository. The proxy mints the GitHub App installation token internally and never returns it, the App private key, or an authorization header.

All requests require the existing short-lived `x-app-harness-assertion`; everything else is a 404. The supported contract is intentionally not a generic GitHub REST proxy:

| Endpoint | Allowed body | Result |
| --- | --- | --- |
| `POST /v1/issues` | `eventId`, bounded `title`, bounded `body`, one fixed `classification` | Creates an issue as the GitHub App bot. |
| `POST /v1/issues/:number/classification` | `eventId`, fixed `classification` | Reconciles only App Harness-managed labels; all unrelated labels survive. |
| `POST /v1/issues/:number/status` | `eventId`, bounded `body` | Creates or updates one bot-authored status comment, identified by `<!-- app-harness-event:<eventId> -->`. |
| `POST /v1/issues/:number/close-after-deployment` | `eventId`, bounded `body`, production `deploymentUrl` | Fetches the configured production origin successfully, records that verified URL in the idempotent status comment, then closes the issue. |

`classification` is one of `triage`, `agent`, `needs-review`, `rejected`, or `deployed`; callers cannot supply arbitrary labels, repositories, issue bodies with arbitrary binary data, GitHub paths, or a deployment host. The proxy checks the deployment URL's HTTPS origin against `PRODUCTION_ORIGIN`, then probes it from the Worker before closing. This proves reachability at the configured live origin; the caller must only use this endpoint after its CI/deploy provider has already recorded the matching successful deployment event.

### App Harness integration contract (not enabled by this change)

The Durable Object/application integration should sign its existing runner-style assertion with a new bounded work-item job ID and `repository: "callil/autonomous-live-chat"`, call these endpoints, and record the returned `issueNumber`/`issueUrl` or verified deployment URL in the durable ledger. It must only render lifecycle states after those calls succeed. It must never send browser-originated values to the proxy without server-side bounds and provenance sanitization. This package does not alter `src/index.ts`, existing workflows, deployment configuration, or the provider enablement switch.
