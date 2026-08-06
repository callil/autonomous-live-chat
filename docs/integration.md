# React integration

`@app-harness/react` is the reusable authoring layer. It knows how to target opted-in elements and collect a safe request envelope; the host decides how to submit it.

```tsx
import { AppHarness, targetAttributes } from "@app-harness/react";
import "@app-harness/react/styles.css";

export function Root() {
  return (
    <AppHarness onRequest={(submission) => fetch("/api/harness/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(submission),
    })}>
      <main {...targetAttributes("workspace", "Workspace")}>
        {/* host application */}
      </main>
    </AppHarness>
  );
}
```

The package is currently an internal workspace package, not a published npm release.

## Contract

Targets must opt in with a stable `data-app-harness-id`; dynamic selectors are rejected. Labels are concise static descriptions. Text is omitted unless a host explicitly marks it safe. Paths must be same-origin and rectangles are bounded numeric viewport context.

The `onRequest` callback is deliberately transport-agnostic. A host may use a Durable Object, an HTTP API, another realtime system, or a test stub without pulling Cloudflare or GitHub code into the UI package.

All styles use `--ah-*` custom properties. The layer stays collapsed by default, uses a high overlay z-index, and avoids changing the host layout.

The launch control, open panel, and its meaningful controls also have stable target IDs. The authoring layer can therefore receive feedback about itself while target mode is active.
