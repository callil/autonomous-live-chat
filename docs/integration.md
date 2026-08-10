# Integration

The entire integration surface is one script tag, served by the frozen platform:

```html
<script src="/overlay.js" defer
        data-room="main"
        data-anchor-mode="data-loc"
        data-repo-url="https://github.com/callil/autonomous-live-chat"></script>
```

The overlay mounts the authoring tools (Target, Comment, Draw), the build queue, and the activity feed into a closed shadow root the host page cannot style, script, or break. It reads the installed tenant's public descriptor from `GET /overlay/tenant` and speaks the platform's room WebSocket directly.

## Contract

- Anchors ride the `data-loc` attributes the product build stamps at module init (file:line references into the product source), so a request points at real code, not a brittle selector.
- Target envelopes contain stable anchors, tag/role, a concise label, same-origin path, and viewport rectangle. They do not contain form values, message bodies, query strings, credentials, or arbitrary DOM serialization.
- The overlay is pointer-transparent except for its own visible controls, and it never influences the host's layout: the dock is draggable and closeable on the overlay's side, and the host renders exactly as if the overlay were absent.
- Submission requires a signed session — the same identity the room itself uses.

The legacy `@app-harness/react` workspace package was removed with the rest of the pre-rebuild system; the overlay above is the one supported integration path.
