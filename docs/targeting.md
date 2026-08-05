# Targeting and integration

## A target is code-facing context, not a screenshot coordinate

App Harness lets a person point at a live element, then describe the change they want. The click produces a bounded target envelope that is persisted with the request and broadcast through the room ledger:

```json
{
  "targetId": "message-composer",
  "selector": "[data-target-id=\"message-composer\"]",
  "tag": "form",
  "role": "form",
  "label": "Message composer",
  "page": "/",
  "room": "main",
  "rect": { "x": 116, "y": 628, "width": 768, "height": 80 }
}
```

`data-target-id` is the durable identity. It must be meaningful and stable across builds, for example `billing-save-card`, `message-composer`, or `settings-profile-name`; it is not a generated CSS class, DOM index, or minified component name. The envelope's selector is derived by the Durable Object from that ID rather than accepted from the browser.

The current reference harness opts elements in explicitly. A target can supply a safe human label (`data-target-label`) or opt in static visible copy (`data-target-text`). Inputs never contribute their values. Dynamic message bodies, query strings, secrets, credentials, and form data are excluded from the envelope.

## Why an agent needs more than the DOM

An agent can use the envelope to understand *where the person pointed* and *what they asked*. To turn that into a safe code change, it also needs a build-time provenance map: `data-target-id` to source file, component/export, and optional repository-relative ownership metadata. Coordinates help orient the live interaction; they are not a reliable code locator.

For React, Vite, and similar production builds, literal `data-*` attributes survive minification. App Harness should therefore ship an integration that injects or validates readable target IDs and emits a private candidate-workspace manifest. The agent receives the envelope plus that manifest only inside the guarded workspace; the public browser never receives source paths or repository metadata.

## Intended installable harness

The intended product is an installable App Harness adapter, not a copy of this chat UI and not a redistribution of Agentation. An application should eventually add one small adapter, configure a project/endpoint/policy identifier, and mark meaningful elements with readable target IDs. Framework adapters can handle React, Vite, Next.js, or static HTML while preserving the same envelope contract.

A hosted configurator may later create the project configuration, connect the guarded delivery policy, and verify the adapter without asking users to hand-edit internal transport settings. It must not grant an agent broad source, secret, or deployment access merely because the target overlay is installed.

## Current boundary and future handoff

Today, target mode enriches the Durable Object request ledger and public activity record. It does not broaden the deterministic fallback: only the existing exact accent and empty-state transformations can execute. Out-of-policy targeted requests still require human review.

The future NanoCodex handoff should pass the request, sanitized target envelope, and candidate-workspace provenance manifest to an isolated agent session. CI and the Durable Object remain the validation, policy, and audit authorities. The OpenAI API-key prerequisite described in [Next architecture: NanoCodex](./next-architecture-nanocodex.md) remains unchanged.

Freehand marks and comments are a separate feedback channel; see [Overlay canvas](./overlay-canvas.md). They create durable intake items for triage. A comment that exactly matches the already-approved fallback grammar is the narrow exception: it is dispatched as a guarded autonomous request. Other comments and all drawings remain recorded feedback until NanoCodex is configured.
