# Product

## Intent

App Harness explores a direct idea: people should be able to point at live software, describe what should change, watch the work happen, and see a validated result arrive without translating their intent into a separate ticketing ritual.

The first demonstration is deliberately a chat app. It is small enough that the autonomous loop is legible, but includes real frontend, backend, persistent state, realtime behavior, CI, deployment, and multiple users.

## Experience

- Normal use remains a quiet chat interface.
- A small floating launcher summons the authoring layer.
- Target mode lets a contributor select a stable, opted-in UI element.
- Submitting creates immediate local acknowledgement, a durable work item, and a public GitHub issue.
- Activity is available on demand and links to real issues, pull requests, checks, and deployment state.
- Valid work proceeds autonomously. The agent explains refusals and failures instead of displaying fictional progress.

The authoring layer should feel placed over the host app, not built into its permanent navigation. The reusable layer and the host product therefore live in separate packages.

## Autonomous operator

Cloudflare OS holds the long-lived repository conversation. An ephemeral coding process receives a clean checkout for each implementation job. It can inspect and edit the full repository, use investigation subagents, run normal engineering tools, and produce one pull request or a genuinely dependent stack.

Its default attention is the demo app—both frontend and backend. This is a prompt and ownership convention, not a hard path restriction. Cross-cutting changes may update the React wrapper, tests, workflows, migrations, or infrastructure.

## Completion contract

A change is complete only when its durable work item links the public intent to actual repository artifacts, required checks pass, the tested commit is promoted in stack order, production is reachable, and the issue/app state is reconciled. An issue, generated patch, green-looking UI, or unverified deployment alone is not completion.
