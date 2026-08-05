# Livework

A deliberately small multi-user chat proof of concept. A Cloudflare Worker serves the interface and routes each room to one Durable Object. The Durable Object persists the latest 200 messages and broadcasts new messages to every connected WebSocket client.

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

## Extension seam: autonomous iteration

The chat room is intentionally the only active product feature. `ChatRoom` is already the ordered, durable room coordinator. A future workflow can add room-scoped status events (for example: request received, work underway, awaiting review, deployed) and broadcast them through the same durable coordination point. The quiet **Workflow** area in the UI is reserved for that thin status rail.

This first version does not include any autonomous code-editing or deployment behavior.
