# Code review

This review accompanied the three-surface repository split.

## Fixed

- Product, reusable React UI, and infrastructure now have separate workspace roots.
- Root scripts run the complete workspace check; workflows no longer duplicate drifting command lists.
- Cloudflare binding types are regenerated instead of committing inconsistent generated copies.
- WebSocket close handlers no longer echo runtime-reserved close codes back through `close()`.
- Connecting a browser no longer triggers GitHub backfill/reconciliation side effects.
- The visual candidate check follows the demo's new path.
- Agent instructions explicitly prioritize the demo while preserving full-repository autonomy.
- The React wrapper has a stable target contract, tokenized overlay styling, and focused tests.

## Remaining debt

1. The durable ledger supports dependent stack nodes, but trusted validation/promotion currently rejects multi-node stacks. Real GitHub stack identity/order verification and sequential promotion are still required.
2. `apps/demo/src/index.ts` is still a large composition root. Product protocol and Durable Object orchestration should be extracted into smaller modules without splitting the room's consistency boundary.
3. The framework-free demo and React package share a documented target contract but not one imported implementation. A small framework-neutral core package would remove that duplication when a second production host exists.
4. End-to-end acceptance still depends on healthy OpenAI, GitHub Actions, GitHub, and Cloudflare services. Durable recovery handles interruption, but cannot manufacture a successful external result during an outage or exhausted API balance.
5. `npm audit` currently reports transitive `undici` advisories through the latest Wrangler/Miniflare release. Miniflare pins that version exactly; forcing a dependency override or downgrading Wrangler was not accepted without upstream compatibility evidence. Track the next Wrangler release and re-run the audit.
