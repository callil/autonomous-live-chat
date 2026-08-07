# `@app-harness/react`

Reusable, transport-independent App Harness authoring UI.

It supplies a collapsed floating launcher, opt-in element targeting, a compact request composer, safe target-envelope helpers, and tokenized overlay styles. It intentionally has no Cloudflare, GitHub, room-storage, or agent dependency.

## Target markup contract

`@app-harness/react` recognizes one opt-in contract. Use `targetAttributes` in React, or apply the same attributes in another renderer:

- `data-app-harness-id`: a stable readable ID, such as `message-composer`;
- `data-app-harness-label`: a short static description, such as `Message composer`;
- `data-app-harness-text="true"`: optional; allows the element's rendered text into the safe target envelope.

No legacy aliases or selector-based targeting are recognized. App Harness derives a stable target envelope from this markup and never reads input values or arbitrary page content.

See [the integration guide](../../docs/integration.md).
