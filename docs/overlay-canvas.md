# Overlay canvas

App Harness puts its authoring controls **around** the host application without turning them into permanent chrome. A single small floating launcher at the lower-right opens a compact annotation menu and closes again from the same control or its close button. The host therefore reads as ordinary chat until someone chooses to annotate it. This is deliberately a narrow interaction: inspect, point, explain, then return to the work.

## Current feedback protocol

The summoned menu has only three intentional tools:

- **Target** selects an opted-in `data-target-id` and opens a request composer. It creates the existing change-request lifecycle.
- **Comment** selects an opted-in element and saves a short feedback note as a durable annotation. It does not start the autonomous runner.
- **Draw** records bounded freehand screen-space points as a durable annotation. It does not start the autonomous runner.

The per-room Durable Object persists the latest 100 annotation records and a matching durable activity record, then broadcasts both snapshots to every connected client. Comments include the same sanitized target envelope used by requests. Drawings include page/room context and up to 240 normalized screen-space points. The overlay never includes input values, message bodies, query strings, credentials, or secrets in target metadata.

Every submission is acknowledged in the compact composer or authoring menu and gets an activity state: **received**, **triaged**, **queued**, **building**, **completed**, **rejected**, or **needs review**. Each one also creates a real GitHub issue containing its safe context; the on-demand **Activity** list survives reconnects and exposes the actual issue URL (and a pull-request URL when a guarded candidate exists). If external issue creation fails, that failure is shown instead of being hidden.

The **Annotations** control opens a small manager only when needed. Each annotation entry has a direct **Remove** action, and **Clear all canvas marks** asks for confirmation that it affects this room's annotations only. Both operations are durable and immediately broadcast to connected clients. They never remove or alter ordinary chat messages.

## Self-targeting

The host sidebar, its navigation items, the floating launcher, and every meaningful open-menu control use human-readable `data-target-id` values and safe labels. In inspect mode they are highlighted and intercepted exactly like host content: selecting one opens the targeted composer instead of activating its normal action. Selecting the Target control first leaves inspect mode, which prevents a recursive toggle. This makes the App Harness authoring surface itself available for carefully scoped future change requests.

Comments and drawing marks are an intake layer; they do not widen the deterministic fallback policy. A comment that exactly matches the documented fallback grammar (accent or empty-state copy) becomes a real guarded candidate request and can progress through GitHub candidate/CI/deploy. Any other comment, and every drawing, is visibly recorded as **awaiting coding-agent triage** with its GitHub issue. It does not silently build itself.

## Tldraw adapter decision

Tldraw is a strong fit for a future adapter: its documented `hideUi` mode permits a custom host toolbar, its editor can be controlled through `onMount`/`useEditor`, and it supports exported canvas images. Its current production licensing model requires a valid domain-bound license key; local development does not. App Harness therefore does **not** embed or redistribute tldraw in this deployed build without a license.

Once a suitable license is configured, the native drawing layer can be replaced behind the same annotation protocol with a focused tldraw adapter: default UI hidden, only comment and draw controls exposed, and a private canvas/image export sent as candidate-workspace evidence. The App Harness overlay remains outside the host application either way.

## Screenshot handoff

An agent needs both semantic and visual context:

1. the request or comment text;
2. the durable target envelope and target-to-source provenance manifest;
3. the annotation vectors; and
4. a screenshot of the host page with the overlay annotations composited on top.

The present browser-only reference persists vectors and target rectangles, which is sufficient to render the feedback consistently for every client. A generic injected overlay cannot reliably capture an arbitrary host page by itself—cross-origin content and browser permission rules apply. The installable adapter should accept a host-provided `captureScreenshot` function; a browser extension or the embedding app can implement it with the appropriate user-visible permission. The resulting image must be stored as candidate-workspace evidence, not made public by default, and then passed with the envelope to the isolated coding agent.
