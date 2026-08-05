# Overlay canvas

App Harness now puts its authoring controls **around** the host application: a thin, persistent lower instrument strip, inspired by CAD status rails. The host stays focused on its own UI; its collapsed sidebar remains navigational. The rail is quiet when idle, carries the precise target control and a concise operational state, and reveals detailed activity only on demand. The overlay is designed to become an installable adapter for other applications.

## Current feedback protocol

The lower instrument strip has three intentional tools:

- **Target** selects an opted-in `data-target-id` and opens a request composer. It creates the existing change-request lifecycle.
- **Comment** selects an opted-in element and saves a short feedback note as a durable annotation. It does not start the autonomous runner.
- **Draw** records bounded freehand screen-space points as a durable annotation. It does not start the autonomous runner.

The per-room Durable Object persists the latest 100 annotation records and broadcasts their snapshot to every connected client. Comments include the same sanitized target envelope used by requests. Drawings include page/room context and up to 240 normalized screen-space points. The overlay never includes input values, message bodies, query strings, credentials, or secrets in target metadata.

Comments and drawing marks are feedback for a future candidate-workspace agent. They are not instructions and they do not widen the deterministic fallback policy.

## Tldraw adapter decision

Tldraw is a strong fit for a future adapter: its documented `hideUi` mode permits a custom host toolbar, its editor can be controlled through `onMount`/`useEditor`, and it supports exported canvas images. Its current production licensing model requires a valid domain-bound license key; local development does not. App Harness therefore does **not** embed or redistribute tldraw in this deployed build without a license.

Once a suitable license is configured, the native drawing layer can be replaced behind the same annotation protocol with a focused tldraw adapter: default UI hidden, only comment and draw controls exposed, and a private canvas/image export sent as candidate-workspace evidence. The App Harness lower instrument strip remains outside the host application either way.

## Screenshot handoff

An agent needs both semantic and visual context:

1. the request or comment text;
2. the durable target envelope and target-to-source provenance manifest;
3. the annotation vectors; and
4. a screenshot of the host page with the overlay annotations composited on top.

The present browser-only reference persists vectors and target rectangles, which is sufficient to render the feedback consistently for every client. A generic injected overlay cannot reliably capture an arbitrary host page by itself—cross-origin content and browser permission rules apply. The installable adapter should accept a host-provided `captureScreenshot` function; a browser extension or the embedding app can implement it with the appropriate user-visible permission. The resulting image must be stored as candidate-workspace evidence, not made public by default, and then passed with the envelope to the isolated coding agent.
