# The overlay and tenancy

App Harness attaches to an app it knows nothing about. The end state is
`npx app-harness init` run against someone else's existing application: a few
CLI questions, and they get an autonomous app.

That goal decides the architecture. The overlay is not "our room UI, moved
somewhere else" — it is a drop-in layer, and `product/` in this repository is
merely **an example app that happens to be installed**. A tenant, not a
partner.

## The split

| Surface | Owner | Agent may modify | Contains |
| --- | --- | --- | --- |
| `product/` | the tenant | yes | The app itself. Here: a chat room. |
| `platform/src/overlay/` | the platform | **no** (CI firewall) | Authoring tools, build queue, activity feed, provenance. |

The reason the status surface is platform-owned is not tidiness. The overlay
reports on builds that modify the app. If it lived in the app, an agent change
could break it or make it lie about its own work — the report and the thing
being reported on would share a fate. Serving it from the frozen platform makes
that structurally impossible.

## Isolation: why a closed shadow root, not an iframe

The overlay renders into `attachShadow({ mode: "closed" })`.

- **Closed, not open**: the host page cannot obtain the root, so it cannot
  style, script, or scrape the overlay even accidentally. CSS does not
  inherit in, and overlay CSS cannot leak out. The app may restyle itself
  completely — and agents *will* restyle it — with no effect here.
- **Not an iframe**: the authoring tools must hit-test the host app's DOM
  (`elementFromPoint`, `getBoundingClientRect`, reading the captured subtree)
  to know what a requester pointed at. A cross-document iframe cannot do that
  without the app cooperating, and requiring cooperation is exactly the
  coupling we are removing. The shadow root gives the same style isolation
  while keeping same-document hit-testing.

The overlay writes exactly one thing to the host DOM: a
`data-app-harness-hilite` attribute on the element currently selected, removed
as soon as the selection clears.

## Anchoring degrades; it never requires a build plugin

Two tiers, in order:

1. **`data-loc="<file>:<line>"`** — when the app opted into the stamping
   plugin. The agent gets an exact source line. An optimization.
2. **Structural selector + captured DOM** — always available. The overlay
   derives a stable selector from the DOM itself, preferring `data-testid`,
   `aria-label`, and ids over class names, and filters out framework-generated
   class noise (`css-1a2b`, `svelte-x1y2`, `ng-*`). It reports honestly
   whether the selector resolved uniquely.

Tier 2 is the contract that matters. An overlay that only works in tier 1 is
coupled to the app's build pipeline.

## Tenancy is configuration

`platform/contracts/tenant.js` holds the shape a CLI would collect: repository,
source root, anchor mode, test command, deploy command, framework hint. It
validates loudly rather than guessing — commands are argv arrays, never shell
strings, so there is nothing to quote or interpolate.

`INSTALLED_TENANT` is the example room. Installing App Harness against a
different app means replacing that descriptor.

## Productization backlog

Honest list of what still couples this harness to this specific app. None of it
is load-bearing for the overlay, but all of it must go before `init` is real:

1. **Deploy is a hardcoded workflow.** The platform dispatches
   `deploy-product.yml` by filename and polls a `PRODUCT_URL` for `/version`.
   A tenant's deploy command and liveness probe belong in its descriptor.
2. **The local test gate is hardcoded.** `job-entrypoint.mjs` runs
   `product/test/ui-contract.test.mjs` literally. It should run
   `tenant.testCommand`.
3. **The agent's system prompt names `product/`.** `buildAgentInstructions`
   tells the model the product surface is `product/`; it should name
   `tenant.sourceRoot`.
4. **The write firewall is a static path list.** Both the CI firewall and the
   in-agent `WRITE_DENIED_PATHS` hardcode `platform/`, `infra/`, `apps/`. These
   should be derived from the tenant's source root (allowlist) rather than
   enumerated as a denylist.
5. **One room, one tenant.** `ROOM_DO.getByName("main")` and the single
   `INSTALLED_TENANT` export assume exactly one installed app.
6. **The repository is a platform var.** `REPOSITORY` is a worker var shared by
   the platform and runner rather than per-tenant configuration.
7. **The product still proxies `/api/*` and `/overlay.js`.** Convenient for a
   same-origin demo, but a third-party app should be able to point the overlay
   at the platform's origin directly (`data-api-base`), which the overlay
   already supports but the install path does not yet exercise.
8. **Session/join lives in the app.** The overlay waits for a session the app
   creates. A BYO app has no join flow, so the overlay will need its own
   identity affordance.
