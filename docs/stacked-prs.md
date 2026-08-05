# Stacked PR scheduling

Stacks are an integrity invariant, not a project-management flourish. Without them, concurrent autonomous PRs can each chase `main`, become stale as a sibling lands, rerun CI and rebase independently, then repeat indefinitely. App Harness prevents that loop by representing dependent work as one ordered stack.

Each stack has one root issue, one base SHA, a bounded lane, a monotonic generation, and an ordered list of intent slices. The first branch is based on the recorded `main` SHA. Every later branch is based on its immediate parent branch, and each GitHub pull request uses that parent as its base. A small request remains a direct single-PR path; a stack is created only when an executor has explicitly decomposed the request into dependent slices.

```text
main @ base SHA ──> slice 1 PR ──> slice 2 PR ──> slice 3 PR
                    root             child            child
```

## Scheduling rules

- A stack has one CI concurrency key: `app-harness-stack-<id>-generation-<n>`. Starting a newer generation cancels stale CI work.
- When `main` advances, the ledger becomes `needs-restack`. The executor rebases/restacks **the root once** onto the new SHA, then deterministically regenerates each descendant from its parent. Descendants never independently rebase onto `main`.
- A failed, closed, or blocked lower PR blocks every descendant. The ledger reports `blocked`; it never reports production success for a blocked child.
- A lower merge promotes the remaining stack only after the root/base relation is refreshed. It is not a claim that the whole stack reached production.
- Unrelated work uses separate bounded lanes/queues. A lane admits one active generation so independent automation cannot turn into a rebase race.

The Durable Object records `baseSha`, `generation`, lane, parent/child PR links, intent slice, CI status, deployment status, and stack health. It broadcasts `needs-restack` and `blocked` exactly as they occur. The executable transition rules live in [`src/stack-scheduler.js`](../src/stack-scheduler.js), with a focused transition test in [`scripts/test-stack-scheduler.mjs`](../scripts/test-stack-scheduler.mjs).
