# Deferred proposal and preview experience

This is a product design for after the basic production loop is proven. It is
not enabled in the current App Harness UI and is not part of the first E2E
acceptance path.

## Public proposals

A targeted authoring item may eventually be submitted as either:

- a **request**, which enters the autonomous implementation loop immediately;
- a **proposal**, which opens a public discussion and cannot start an
  implementation run until its author explicitly approves it.

The proposal, discussion, agent replies, approval, and later implementation
artifacts belong to the existing Durable Object ledger. They must not introduce
a second conversation store or coordinator.

The intended proposal state is:

```text
proposed -> discussing -> approved -> normal request lifecycle
    |            |
    +----------> withdrawn
                 rejected
```

The operator Worker may classify a proposal, ask questions, summarize
the evolving idea, and recommend proceeding or declining. It must not delegate
implementation before durable approval. Approval is idempotent and tied to the
authenticated author's stable principal; a display name, cookie-local flag, or
anonymous browser state is not sufficient authorization.

The current anonymous demo therefore intentionally exposes no Proposal control.

## In-app build projections

Once implementation begins, the host may render an optional projection over
the targeted element:

- a restrained outline or shimmer while an implementation is running;
- a placeholder when the accepted plan describes a new region;
- an opt-in preview after a candidate artifact exists;
- a clear failed, paused, or completed state when the ledger says so.

These visuals are projections of durable facts. They may use only the stable
target envelope, exact ledger phase, and validated preview artifacts. The
client must never infer that work is building from elapsed time, a pending
network request, or an optimistic local flag.

Preview content must be isolated and provenance-linked to the candidate stack
head. Do not inject arbitrary agent-authored HTML into the live application.

## Activation gate

Do not enable this experience until all of the following are true:

1. The basic target-to-production E2E has completed without manual work.
2. App Harness has a trustworthy user identity for author-only approval.
3. Per-item public discussion pagination and reconnect recovery are proven.
4. Preview artifacts are schema-validated and bound to an immutable candidate.
5. The optional overlay remains dismissible and adds no permanent host chrome.
