import assert from "node:assert/strict";
import {
	AUTHORING_ENVELOPE_POLICY,
	DELIVERY_POLICY,
	PLATFORM_LIMITS,
	durableRecordBytes,
	fitsDurableRecord,
	storageDeleteBatches,
} from "../../packages/contracts/index.js";

assert.equal(PLATFORM_LIMITS.cloudflareDurableObject.keyAndValueBytes, 2_000_000, "record admission follows Cloudflare's documented SQLite Durable Object limit");
assert.equal(PLATFORM_LIMITS.cloudflareDurableObject.deleteKeysPerCall, 128, "batch deletion follows Cloudflare's documented async KV API limit");
assert.equal(DELIVERY_POLICY.historyRecordsPerPage, PLATFORM_LIMITS.cloudflareDurableObject.getKeysPerCall, "the record ceiling is the documented multi-key boundary, not a guessed product cap");
assert.equal(DELIVERY_POLICY.historyPageBytes, PLATFORM_LIMITS.cloudflareDurableObject.keyAndValueBytes, "the byte ceiling is one maximum durable record, not a guessed multiplier");
assert.equal(AUTHORING_ENVELOPE_POLICY.safeTextCharacters, 120, "the sanitized target text schema is named and shared by the server contract");

const fitting = { text: "x".repeat(128) };
assert.ok(fitsDurableRecord("message:test", fitting));
assert.equal(durableRecordBytes("message:test", fitting), Buffer.byteLength("message:test") + Buffer.byteLength(JSON.stringify(fitting)));

const deleteBatches = storageDeleteBatches(Array.from({ length: 129 }, (_, index) => `annotation:${index}`));
assert.deepEqual(deleteBatches.map((batch) => batch.length), [128, 1], "deletes crossing the Cloudflare boundary are split without dropping keys");

console.log("platform-derived storage and delivery policy contracts passed");
