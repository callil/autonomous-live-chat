# Control-plane migration

The simplified architecture has one durable ledger and one persistent Cloudflare OS operator. The demo Worker is the intake and realtime rendering surface, not a second workflow engine.

Until the cutover is complete, [`infra/tests/control-plane-migration-allowlist.json`](../infra/tests/control-plane-migration-allowlist.json) is the exact, machine-checked inventory of legacy demo-worker responsibilities. The inventory is intentionally small and explicit:

| Temporary responsibility in the demo | Target owner | Cutover condition |
| --- | --- | --- |
| Coordinator imports, job and outbox records | Cloudflare OS operator plus the durable ledger | Remove the demo coordinator and its alarm/retry loop. |
| Direct GitHub API reads, issue updates, and Actions dispatch | OS operator and the repository-scoped GitHub App | The demo only records and renders typed ledger artifacts. |
| Native runner and GitHub identity bindings | OS operator’s private capability boundary | The demo deployment has neither binding. |
| Signed workflow callback routes and synchronized callback/identity secrets | Narrow, typed ledger result recording through private RPC | The old callback state machine and duplicated secret copies are deleted. |

Run the boundary test directly with:

```sh
node infra/tests/control-plane-boundary.test.mjs
```

It scans the production demo source and its deployment configuration. Every detected violation must have exactly one allowlist entry with the exact current match count and a removal criterion. A new use, an increased count, or a stale entry fails the test. When a cutover step deletes a responsibility, delete its allowlist entry in the same pull request. The required end state is an empty `entries` array.

This is a migration guard, not a permanent compatibility mechanism. It makes the remaining architecture debt visible while preventing it from spreading.
