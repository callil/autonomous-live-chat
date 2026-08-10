# Testing doctrine

Two things happened on the same day, and this document exists because of them.

1. **A false green.** Every overlay test was a source grep — read the file,
   assert it contains a string. All of them passed while the shipped overlay
   threw `ReferenceError` on page load. The WebSocket never started and the
   room was inert for users. A grep can prove a string is present; it cannot
   prove the code runs.

2. **A false red.** PR #269 added assertions pinning exact prose ("the heading
   must equal X"), magic numbers, and the one-line formatting of an
   implementation. Those parked a legitimate agent change **twice**.

The second is the one people underrate. In a normal repo a brittle test annoys
a developer for ten minutes. Here, the pipeline is autonomous: a brittle test
**rejects a user's real request and tells them it failed**. Over-testing is not
the safe direction. It has a cost, it is paid by users, and it is paid silently.

## Two rules

### 1. Test behaviour at boundaries, never source text

No new assertion may read a source file and match a string against it. If the
claim is "this works", execute it and observe the result. Source-reading
assertions survive only where the thing being asserted genuinely *is* the
source: a CI firewall path list, a wrangler binding, a protocol literal that
must not appear in the wrong layer.

The tell: if an agent could satisfy the test by pasting the right string in
without making the feature work, it is not a test.

### 2. Test invariants, not content

Test what must be true of **any** version of the app. Do not test what this
version happens to say or look like.

| Do test | Do not test |
|---|---|
| the send control is hittable | the send button says "Send" |
| a message round-trips over the socket | messages use a 1.75rem avatar column |
| the app boots without console errors | the heading equals "Ask for a change." |
| a speaker is coloured consistently | the hash is `Math.imul(hash, 16777619)` |
| every element carries a data-loc anchor | the intro paragraph begins "Chat with the room" |

Agents **will** and **should** change copy, colour, spacing, and structure —
that is what the product surface is for. A test that forbids it is a bug in the
test.

## Three layers

Each catches a different class of failure. None of them substitutes for another.

### Layer 1 — Contract tests (`platform/test/*.test.mjs`)

Pure functions in `platform/contracts`: ledger, queue, intent, envelope, feed,
reconcile, checks, session, tier. Already the strongest part of the suite.
Fast, deterministic, no I/O.

**Catches:** wrong state transitions, unsafe configuration accepted, a green
verdict from zero checks, a sequence hole in the ledger.

One addition worth calling out: `evidence.test.mjs` lifts the **real**
`collectEvidence` out of `platform/src/index.ts` and executes it. It exists
because `request-fidelity.test.mjs` tests a *reimplementation* of that method
written inside the test file — and reintroducing the original outage into the
shipping worker left all seven of its assertions green. **Behavioural coverage
of a copy is still a false green.** If a test needs a function the runtime
owns, lift the real one.

### Layer 2 — Boot / behaviour tests

`platform/test/overlay-boot.test.mjs`, `product/test/room-boot.test.mjs`, and
the behavioural halves of `ui-contract` and `update-awareness`. These execute
the actual client scripts against the shared DOM harness in
`platform/test/support/dom.mjs` and assert they **run**: no throw on mount, the
transport starts, controls exist and are pointer-hittable, insets publish, a
message round-trips.

**Catches:** failure mode A. A load-time throw, a transport that never starts,
a control that is drawn but unclickable, a room that renders but is inert.

The harness is deliberately dependency-free rather than jsdom: these are plain
DOM scripts, the stub installs nothing, and — importantly — it **throws on any
API it does not implement** instead of silently absorbing the call. A permissive
mock would reintroduce false greens through the back door. (It already caught
one: `meta.content` was returning `undefined` because only attributes were
modelled, which would have made an update-awareness assertion vacuously pass.)

Boot tests run in CI's **product lane**, not just the full suite. They are the
lane an agent change actually goes through and they cost a few hundred
milliseconds.

### Layer 3 — Smoke against a real deploy (`npm run smoke`)

Runs **post-deploy, never pre-merge** — it is a detector, not a gate. It fetches
the deployed origin and asserts: the page is served, `/version` reports a real
SHA matching the merge, the page's stamp agrees with it, both deployed scripts
(room client *and* platform overlay) execute without throwing, the send control
is hit-testable, a session can be created, and the fallback UI is reachable.

Runs in about 400ms against the live origin; budget is 60s.

**Catches:** a deploy that did not land, a stale asset, a binding that is not
wired, a platform and product that disagree about what is live — none of which
any working-tree test can see.

**Honest limitation:** there is no headless browser. Adding Chromium costs more
CI install time than these checks are worth, and the boot layer already executes
both scripts on every run. So real CSS layout, paint, stacking/z-index, and
genuine browser event dispatch are **not** covered. A control mispositioned
purely by CSS would still pass. That is a known hole, written down rather than
papered over.

```
npm run smoke                                   # default product origin
npm run smoke -- --url https://… --sha <sha>    # a specific deploy
```

## Writing a new test

Before adding one, answer: **would this have caught a real outage, or does it
protect a real invariant?** If neither, do not add it. ~25 load-bearing tests
beat hundreds that mostly assert the code is still spelled the same way.

Then verify it the way this suite was verified: **break the thing deliberately
and watch the test fail.** A test never observed failing has not been shown to
test anything. Every boot test here was proven against a deliberately broken
build — the reintroduced `dockEl` TDZ error, a transport that never starts, a
dropped boot marker, a composer that does not send, an auto-reload that eats
the user's draft.

## What is deliberately not tested

- **Copy, colour, spacing, layout, class names.** The agent's to change.
- **Real CSS layout and paint.** No headless browser (see Layer 3).
- **The WebSocket server round-trip end to end.** Contract-tested on both
  sides; the live socket handshake is not exercised.
- **Multi-client concurrency** — two users racing on the same intent.
- **The runner sandbox executing a real build.** Out of process, out of scope.
