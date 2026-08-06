# Platform policy

App Harness does not use character counts or retained-record counts as product policy. It separates three concerns:

1. **Retention:** accepted messages, annotations, and work items remain individual durable records. Loading a page never deletes older records.
2. **Delivery:** clients receive a bounded page and live deltas. They can explicitly load earlier pages. The page size is a latency/memory tuning value, not a history limit.
3. **Admission:** one record must fit the platform that stores it. Admission is measured in UTF-8 bytes against Cloudflare's documented SQLite Durable Object key-plus-value limit. An oversized single submission is rejected visibly and can be split into smaller steps.
4. **Authoring envelope:** target metadata is intentionally narrow so the overlay never captures arbitrary DOM state, form values, or secrets. Its named schema bounds live beside the platform policy; they do not limit the request text itself.

The canonical values and helpers are in `infra/contracts/platform-policy.js`; TypeScript consumers use its adjacent declaration file. Tests verify that a delivery page fits one documented multi-key read and that multi-key deletion is batched at Cloudflare's documented boundary.

## Current sources and rationale

| Setting | Reason |
| --- | --- |
| Durable Object key + value: 2,000,000 bytes | Cloudflare SQLite-backed Durable Object platform limit |
| Durable Object multi-key get/delete: 128 keys | Cloudflare asynchronous storage API limit |
| WebSocket receive: 32 MiB | Cloudflare platform limit; App Harness uses the smaller durable-record budget for events it must persist |
| History delivery page: 64 records | Operational working set, deliberately no larger than one multi-key read; changing it does not affect retention |
| History delivery page: 4,000,000 serialized bytes | Byte ceiling equal to two maximum Durable Object records; record count is only an additional upper bound |

Cloudflare references:

- <https://developers.cloudflare.com/durable-objects/platform/limits/>
- <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>

GitHub's current REST OpenAPI description types issue and comment bodies as strings without publishing a maximum. App Harness therefore does not guess one. The GitHub App first sends the complete durable text. If GitHub explicitly answers `422 Unprocessable Entity`, the bridge retries once with a compact pointer to the durable work item; other errors retain their normal retry semantics.
