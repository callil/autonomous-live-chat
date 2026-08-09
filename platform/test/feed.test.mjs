import assert from "node:assert/strict";
import test from "node:test";
import { formatEta, renderFeed, renderFeedItem, renderQueueChips } from "../contracts/feed.js";
import { createLedgerEvent, LEDGER_EVENT_KINDS } from "../contracts/ledger.js";
import { enqueueRun, startRun } from "../contracts/queue.js";

test("every ledger event kind has a deterministic template", () => {
	const payloads = {
		"utterance": { author: "callil", text: "hi" },
		"annotation": { by: "callil", annotation: { kind: "target", dataLoc: "app/header:3:1", domSnapshot: "<a/>" } },
		"request-accepted": { intentId: "intent-1", by: "callil", text: "darken the header", at: 1_000, cancelDeadline: 11_000 },
		"request-cancelled": { intentId: "intent-1", by: "callil" },
		"intent-opened": { intentId: "intent-1", by: "callil" },
		"intent-amended": { intentId: "intent-1", by: "callil", version: 2 },
		"intent-dispatched": { intentId: "intent-1", runId: "run-1" },
		"intent-live": { intentId: "intent-1" },
		"intent-parked": { intentId: "intent-1", reason: "run-ttl-exceeded" },
		"intent-withdrawn": { intentId: "intent-1" },
		"run-queued": { runId: "run-1", intentId: "intent-1" },
		"run-started": { runId: "run-1", intentId: "intent-1", attemptId: "attempt-1", branch: "room/12/abcd1234" },
		"run-heartbeat": { runId: "run-1", intentId: "intent-1", step: "cloned" },
		"run-verifying": { runId: "run-1", intentId: "intent-1", branch: "room/12/abcd1234", prNumber: 7, headSha: "a".repeat(40) },
		"pr-merged": { runId: "run-1", intentId: "intent-1", prNumber: 7, mergeSha: "e".repeat(40) },
		"run-merged": { runId: "run-1", intentId: "intent-1", mergeSha: "e".repeat(40) },
		"run-failed": { runId: "run-1", intentId: "intent-1", reason: "ci-red" },
		"run-parked": { runId: "run-1", intentId: "intent-1", note: "over budget" },
		"deploy-requested": { sha: "b".repeat(40), runId: "run-1" },
		"deploy-observed": { sha: "b".repeat(40) },
		"rollback-requested": { sha: "c".repeat(40), reason: "liveness-fetch-failed" },
		"rollback-observed": { sha: "c".repeat(40) },
		"liveness-failed": { reason: "status-500" },
		"room-frozen": { by: "owner" },
		"room-unfrozen": { by: "owner" },
		"revert-requested": { sha: "d".repeat(40), by: "owner" },
		"budget-exhausted": { day: "2026-08-09" },
	};
	const silentKinds = new Set(["utterance", "run-heartbeat"]);
	for (const kind of LEDGER_EVENT_KINDS) {
		assert.ok(kind in payloads, `test coverage for ${kind}`);
		const item = renderFeedItem(createLedgerEvent({ seq: 1, kind, at: 1, payload: payloads[kind] }));
		if (silentKinds.has(kind)) {
			assert.equal(item, null, "chat and heartbeats render outside the feed");
		} else {
			assert.equal(typeof item.text, "string");
			assert.ok(item.text.length, `template for ${kind} renders text`);
		}
	}
	assert.throws(() => renderFeedItem({ seq: 1, kind: "model-opinion", at: 1, payload: {} }), /No feed template/u, "an unrenderable fact is a loud contract violation");
});

test("the projection is deterministic: same facts in, same feed out", () => {
	const events = [
		createLedgerEvent({ seq: 1, kind: "request-accepted", at: 1_000, payload: { intentId: "intent-1", by: "callil", text: "darken the header", at: 1_000, cancelDeadline: 11_000 } }),
		createLedgerEvent({ seq: 2, kind: "run-queued", at: 12_000, payload: { runId: "run-1", intentId: "intent-1" } }),
	];
	const queue = enqueueRun([], { runId: "run-1", intentId: "intent-1", enqueuedAt: 12_000 });
	const first = renderFeed({ events, queue, now: 20_000, frozen: false });
	const second = renderFeed({ events, queue, now: 20_000, frozen: false });
	assert.deepEqual(first, second);
	assert.equal(first.items.length, 2);
	assert.match(first.items[0].text, /darken the header/u, "user speech is quoted verbatim");
});

test("honest queue chips embed position and a moving ETA", () => {
	let queue = enqueueRun([], { runId: "run-1", intentId: "intent-1", enqueuedAt: 0 });
	queue = startRun(queue, { runId: "run-1", attemptId: "attempt-1", startedAt: 0 });
	queue = enqueueRun(queue, { runId: "run-2", intentId: "intent-2", enqueuedAt: 1 });
	const chips = renderQueueChips(queue, 60_000);
	assert.equal(chips.length, 1);
	assert.equal(chips[0].position, 1);
	assert.equal(chips[0].label, "#1 in line · ~4 min");
	const feed = renderFeed({ events: [], queue, now: 60_000, frozen: true });
	assert.deepEqual(feed.queue, chips, "queue state is embedded in the feed payload");
	assert.equal(feed.frozen, true);
});

test("ETAs read as estimates", () => {
	assert.equal(formatEta(30_000), "under a minute");
	assert.equal(formatEta(5 * 60_000), "~5 min");
	assert.throws(() => formatEta(-1), /non-negative/u);
});
