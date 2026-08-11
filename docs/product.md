# Product

## Intent

App Harness explores a direct idea: people should be able to point at live
software, describe what should change, watch the work happen, and see a
validated result arrive without translating their intent into a separate
ticketing ritual.

The first demonstration is deliberately a chat app. It is small enough that the
autonomous loop is legible, but includes real frontend, backend, persistent
state, realtime behavior, CI, deployment, and multiple users.

## Experience

- Normal use remains a quiet chat interface.
- A small floating launcher summons the authoring overlay, served by the
  frozen platform.
- Three envelope kinds are the ONLY request triggers: **Target** (point at an
  element and type the change), **Comment** (a note anchored to an element),
  and **Draw** (sketch over the page). Plain chat is chat — nothing classifies
  an utterance into a change request behind the requester's back.
- Submitting acks immediately with a 10-second cancel window: a slip of the
  finger is one click to undo.
- The activity feed and queue chips are pure projections of durable ledger
  facts. They show what is actually happening — accepted, queued with an
  honest ETA, building, verifying, deploying — and link to the real PR and
  commit. "Live" appears only after the platform observes the deployed app
  serving the merged revision.
- Valid work proceeds autonomously. Refusals and failures are explained in the
  feed instead of displaying fictional progress; a parked request always says
  why.

## Build modes: standard and fast

Every request builds at **standard** quality — the system's best — unless the
requester explicitly asks for a **fast pass** on that one request. Fast trades
quality for speed knowingly: lower reasoning effort, a tighter budget, and a
self-review that checks but does not iterate. The system never downgrades a
run on its own (the earlier automatic "small run" tier measured no wall-clock
win and was removed).

Honesty rule: a fast result is always labeled — "fast pass" on the queue chip,
in the feed line, and in the PR title and body — so nobody mistakes it for the
system's best. If a fast pass disappoints, no special mechanism is needed:
submit a follow-up request at standard mode ("polish this") and it flows
through the same pipeline as any other intent.

## Feedback about the harness itself

The overlay carries a feedback control for the harness UI (its toolbar, panel,
composer). That feedback is recorded verbatim in the ledger and acknowledged
honestly — and it NEVER dispatches a build. The platform is firewalled from
the room's coding agents by design; the harness team reads the ledger and
improves the overlay on its own rails.

## Completion contract

A change is complete only when the verified PR merged at its exact head SHA,
the deploy was OBSERVED serving that revision at `/version`, and the intent's
terminal fact (live or parked) is recorded in the ledger. An open PR, a green
check, or an unobserved deploy is not completion. See
[Pipeline lifecycle](./pipeline.md) for the full phase semantics.
