# App Harness documentation

New contributor? Start with the [quickstart in the repository README](../README.md#quickstart-for-contributors), then read these in order:

1. [Product](./product.md) — intent, experience, build modes, and the completion contract.
2. [Architecture](./architecture.md) — the three surfaces (platform / runner / product), data flow, and trust boundaries.
3. [Pipeline lifecycle](./pipeline.md) — phase semantics (accepted→live), honest-feed rules, build modes, the builder's self-check, harness feedback.
4. [Integration](./integration.md) — the one-tag overlay integration surface.
5. [Operations](./operations.md) — local checks, deployments, admin levers, secrets, and recovery.
6. [Safety](./security.md) — full autonomy with durable, observable guardrails.
7. [Interface system](./design.md) — visual tokens and host/overlay design rules.
8. [Platform policy](./platform-policy.md) — documented runtime limits and the difference between safety guards and product caps.
9. [Overlay and tenancy](./overlay-and-tenancy.md) — the overlay's isolation doctrine, anchor model, and the installed-tenant descriptor.
10. [Testing](./testing.md) — the test doctrine and layers, and what each can and cannot see.
11. [E2E evidence](./e2e-evidence.md) — recorded end-to-end runs (historical).
12. [Deferred proposals and previews](./future-proposals.md) — intentionally disabled designs.

The documents describe what exists. Proposed work is labeled as such.
