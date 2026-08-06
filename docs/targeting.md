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

## Current handoff

Target mode enriches the Durable Object request ledger and public activity record. Every bounded text request follows the same direct persistent Cloudflare OS workspace handoff. The target helps the operator locate intent; it does not replace the original request or grant source, repository, command, or credential authority.

The Cloudflare OS message includes the request and sanitized target envelope. The OS workspace can delegate implementation only through the typed App Harness Gatekeeper capability, after which deterministic code resolves the original durable request and launches the isolated child. See [Cloudflare OS provider](./cloudflare-os-provider.md).

Text comments are implementation requests and use the same OS path. Freehand drawings remain public visual context and receive an issue, but need a text request before autonomous implementation starts. See [Overlay canvas](./overlay-canvas.md).
