# App Harness

App Harness is a deliberately small reference harness for situated, auditable changes to live software. This repository uses a multi-user chat application to prove the full loop. A Cloudflare Worker serves the interface and routes each room to one Durable Object. The Durable Object persists the latest 200 messages and broadcasts new messages to every connected WebSocket client.

Contributor documentation lives in [docs/README.md](./docs/README.md).

The deployed Worker and GitHub repository retain the historical `autonomous-live-chat` infrastructure names for now. The product and integration surface are App Harness.

## Run it

```sh
npm install
npm run dev
```

Open the local URL in two browser windows and send a message from either one. They share the `main` room in real time.

## Deploy it

```sh
npm run deploy
```

## Autonomous change loop

For situated feedback, open the small **App Harness** button at the lower-right, choose **Target**, click a visible element, and describe a change in the compact bottom composer. The room's Durable Object durably stores the request and its public activity record, then broadcasts each transition to every connected client. The authoring surface stays out of the way until it is summoned.

Targeted requests include a sanitized, stable envelope based on an explicit `data-target-id`. It contains the element identity, semantic tag/role, a safe label or explicitly marked static text, page and room context, and its viewport rectangle. Input values, message bodies, query strings, and secrets are not included. See [targeting and integration](./docs/targeting.md).

The optional App Harness overlay frames the host app rather than becoming its permanent chrome. It stays collapsed when not in use and supports target-aware requests plus durable comments and freehand feedback when opened; see [overlay canvas](./docs/overlay-canvas.md). Every submission creates a durable, shared activity item **and a GitHub issue**. The on-demand Activity list exposes the actual issue and pull-request URLs. Only a comment matching the exact fallback grammar enters the current autonomous candidate/CI/deploy loop; other comments and drawings are accurately recorded as awaiting coding-agent triage until NanoCodex is configured.

### Current autonomous policy

The app may autonomously execute only these exact, benign requests:

- `set accent to blue`, `green`, `purple`, or `orange`
- `set empty state to "Your short message"` using only letters, numbers, ordinary punctuation, and at most 80 characters

Everything else is held as **requires review**. The runner never interprets raw request text as a command. It maps an exact supported sentence to one parameter in a fixed transform of `public/index.html`.

For an allowed request, the Durable Object first opens a linked GitHub issue, then GitHub Actions creates a candidate branch and pull request, runs `npm run cf-typegen` and `npx tsc --noEmit`, automatically promotes the policy-approved candidate, then deploys with Wrangler. Authenticated callbacks update the durable public record through **received**, **interpreting**, **preparing candidate**, **validating**, **deploying**, and **completed**. For all other feedback, the issue is marked **awaiting coding-agent triage**—it does not imply that a branch, pull request, or coding agent exists.

### Explicit boundary

The autonomous runner cannot change data, authentication or authorization, credentials, dependencies, Worker configuration, backend logic, workflow policy, or arbitrary source files. It can only make the allowlisted visual/content transformations above. Service credentials authenticate the private runner and callback, and are never exposed to the chat UI or its requests.

The next safe extension is a guarded workflow with a broader, separately reviewed transform catalog. Each new transform should still create a candidate branch, run CI, produce a preview, and require an explicit promotion policy before deployment.
