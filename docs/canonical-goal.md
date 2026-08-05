# Canonical goal: a live, self-evolving App Harness

App Harness is a minimal chat application with one optional contextual authoring launcher. It turns a selected element, comment, or drawing into a durable, shared change request without turning the product into a dashboard.

## Acceptance criteria

1. The normal view is clean chat. Target/comment/draw authoring is summoned from one small launcher, acknowledges submission immediately, and exposes only truthful activity on demand.
2. The per-room Durable Object persists and broadcasts the safe target/provenance envelope, work item, issue/PR URLs, and lifecycle events to every connected client.
3. Eligible work enters a real isolated Cloudflare OS/Sandbox workspace. The workspace has native filesystem, shell, and Git access only to the introduced repository capability.
4. Every request creates a real GitHub issue. The workspace creates a native Git branch and PR. Tiny independent changes use one PR; related dependent changes use an ordered GitHub PR stack.
5. A stack has one root `main` base SHA, ordered parent branches, a generation, and one CI concurrency key. A main advance produces `needs-restack`; only the root restacks onto main, then descendants regenerate from their parent. A failed or closed lower PR blocks descendants. No PR independently auto-rebases onto main.
6. CI and Cloudflare deployment are independent gates. Only their authenticated events can mark validation, deployment, or completion.
7. The app exposes actual GitHub and deployment links/states and never claims an agent ran when it did not.
8. A controlled policy-approved request reaches production with evidence: GitHub issue, PR/stack, CI run, deployment, and visible live change.

## Provider contract

Cloudflare OS is the preferred capability and governance provider. The Workshop uses Cloudflare Access with a native Cloudflare identity/account-member policy; GitHub is not required for Workshop sign-in. Its GitHub Gatekeeper separately introduces exactly one repository resource through user OAuth, and a Sandbox workspace uses a short-lived scoped capability to clone, branch, inspect, edit, test, commit, push, and open/update PRs. The Durable Object is the authoritative App Harness ledger—not the coding agent—and receives an auditable event for every capability use and command summary.

The existing deterministic GitHub Actions path remains a fallback only until the Cloudflare OS path has completed the same evidence chain.
