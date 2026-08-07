# Immutable end-to-end evidence

Two consecutive production requests completed the full autonomous chain on
2026-08-07 (UTC), after the control-plane simplification. Every link below is
immutable GitHub or Cloudflare state.

## Request A — completed end to end, including automatic reconciliation

Request text (submitted through the production overlay, targeting the room
banner): *"Add the word 'Live' in front of the 'Main room' title in the top
banner, so it reads 'Live Main room'."*

| Step | Evidence |
| --- | --- |
| Durable ledger entry | work item seq 8, submitted 12:44:38Z |
| Operator classification + plan | ledger events; labels on the issue |
| GitHub App issue | <https://github.com/callil/autonomous-live-chat/issues/140> (closed automatically, label `deployed`) |
| Isolated NanoCodex run, native Git | branch `app-harness-os/140/g1` |
| One-node stack PR (gh stack) | <https://github.com/callil/autonomous-live-chat/pull/141> |
| Immutable candidate CI | <https://github.com/callil/autonomous-live-chat/actions/runs/31179932931> |
| Serialized promotion, merge, deploy | <https://github.com/callil/autonomous-live-chat/actions/runs/31180044091> (merged 12:53:20Z) |
| Production change | `Live Main room` renders at <https://autonomous-live-chat.coda-a.workers.dev> |
| Truthful completion | ledger phase `completed` 12:54:26Z with deployment URL; issue auto-closed |

## Request B — first full pipeline pass of the night

Request text: *"Change this introduction line to read exactly: 'Chat with the
room. Point at any element to request a change - the agent ships it live.'"*

| Step | Evidence |
| --- | --- |
| GitHub App issue | <https://github.com/callil/autonomous-live-chat/issues/126> |
| One-node stack PR | <https://github.com/callil/autonomous-live-chat/pull/127> |
| Immutable candidate CI | <https://github.com/callil/autonomous-live-chat/actions/runs/31175577001> |
| Serialized promotion, merge, deploy | <https://github.com/callil/autonomous-live-chat/actions/runs/31178201299> (merged 12:27:45Z) |
| Production change | the requested copy renders in production |

Request B's ledger record parked for review at the final bookkeeping step;
the reconciliation-contract fixes that request surfaced (recorded in the PR
history, #128–#139) are exactly what allowed request A to reconcile to
`completed` without intervention minutes later.

No step in either request involved a manual implementation, a hand-created
branch or PR, a direct merge, or an invented status.
