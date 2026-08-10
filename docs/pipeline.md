# Pipeline lifecycle

One request, from a pointed finger to an observed deploy. Everything below is
recorded as append-only ledger facts; the feed and the queue chips are pure
projections of those facts and can never disagree with them.

## Phases

```text
accepted ──(10s cancel window)──> queued ──> building ──> verifying ──> deploying ──> live
    │                                                                                  │
    └─> withdrawn (cancel)          any waiting phase can TTL-park ──> parked <────────┘
                                          (Doctor: stay-parked | one retry-once)
```

| Phase | Meaning | Recorded as |
| --- | --- | --- |
| accepted | The envelope was validated and acked; cancellable for 10s | `request-accepted` (carries the verbatim text and the requester's mode) |
| queued | The cancel window elapsed; the intent joined the strict FIFO singleton queue | `run-queued`, `intent-dispatched` |
| building | The head of the queue got a disposable sandbox run | `run-started` (carries attempt, branch, mode), `run-heartbeat` steps |
| verifying | The runner pushed a plain `room/*` branch and opened a PR; CI runs on the exact head SHA | `run-verifying`, plus a `run-timing` measurement fact |
| deploying | CI green, exact-SHA squash merge landed; waiting to OBSERVE the deploy | `pr-merged`, `deploy-requested` |
| live | The platform observed `/version` serving the merge SHA | `deploy-observed`, `run-merged`, `intent-live` |
| parked | A TTL expired, CI went red, or the build failed — with an honest public reason | `run-parked`/`run-failed`, `intent-parked` |

"Live" is only ever an observation, never an intention: the fact is appended
when the deployed product actually serves the merged revision, not when a
deploy was requested. After it, a 5-minute liveness watchdog runs synthetic
fetches; a failure triggers a deterministic auto-revert to the previous
observed-good SHA (refused across migrations — that parks for the Doctor).

## Honest-feed rules

- The feed is a fixed-template projection keyed on the event kind. User text
  renders as quoted user speech; no model output enters this truth path (the
  Doctor's verdict is constrained to a typed disposition plus a public note
  that renders as exactly that).
- Every accepted request stays visible on a queue chip through every phase
  until its terminal fact — including the honest in-between: a failed build
  awaiting the Doctor's verdict reads "build failed — deciding next step".
- ETAs read as estimates ("~4 min"), never promises.
- A fast pass is labeled "fast pass" on its chip, its feed line, and its PR.
- Progress heartbeats and timing measurements are durable facts but never feed
  lines; a heartbeat never substitutes for a terminal fact.

## Build modes

The request envelope carries `mode: "standard" | "fast"` (default standard).
Fast is the requester's explicit per-request speed trade, relayed verbatim
through the accepted fact, the dispatch, and the runner:

| | standard | fast |
| --- | --- | --- |
| Reasoning effort | medium | low |
| Tool-call ceiling | 12 | 8 |
| Repository tree in prompt | yes | no (anchor-guided) |
| Self-review | check, then fix gaps once | check only |

Neither mode changes what may be written, skips the local test gate, or skips
CI. An unrecognized mode always takes the standard budget: nothing in the
pipeline ever guesses cheap. Contract: `platform/contracts/mode.js`.

## The builder's self-check

Before a run pushes anything, the agent re-reads the verbatim request and
audits its own staged diff against the three recorded first-pass failure
signatures: literal-minimum results that miss the request's evident intent,
one-off inline styles that ignore the app's design language, and collateral
churn from whole-file rewrites (stripped comments, collapsed formatting). In
standard mode it may spend its remaining budget fixing what it finds; in fast
mode the check is text-only. The verdict rides the agent summary into the PR
body.

## Follow-ups and amendments

While an intent is still open (inside its cancel window), an amendment amends
in place. Once dispatched or terminal, a new message is a follow-up intent —
including "polish this" after a fast pass: it needs nothing special, it is
simply the next request in the FIFO queue, built from latest main.

## Harness feedback is not a build

`harness:feedback` envelopes (notes about the overlay itself) are terminal at
creation: recorded verbatim in the ledger with their anchored overlay element,
acked honestly, and never dispatched. The platform is firewalled from the
room's coding agents; the harness improves on its own rails.
