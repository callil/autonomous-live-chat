import assert from "node:assert/strict";
import test from "node:test";
import { formatEta, renderFeed, renderFeedItem, renderQueueChips } from "../contracts/feed.js";
import { createLedgerEvent, LEDGER_EVENT_KINDS } from "../contracts/ledger.js";
import { beginDeploying, beginVerifying, completeRun, enqueueRun, startRun } from "../contracts/queue.js";

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
		"intent-retried": { intentId: "intent-1", runId: "run-2", note: "CI looked flaky; one fresh build." },
		"run-queued": { runId: "run-1", intentId: "intent-1" },
		"run-started": { runId: "run-1", intentId: "intent-1", attemptId: "attempt-1", branch: "room/12/abcd1234" },
		"run-heartbeat": { runId: "run-1", intentId: "intent-1", step: "cloned" },
		"run-timing": { runId: "run-1", intentId: "intent-1", tier: "small", bootMs: 900, cloneMs: 400, agentMs: 21_000, testMs: 40, pushMs: 5_000, totalMs: 27_340 },
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
		"doctor-note": { note: "The deploy crossed a migration; a human needs to look." },
		"harness-feedback": { by: "callil", text: "the dock hides my send button", annotation: { kind: "harness-feedback", label: "Target tool" } },
	};
	const silentKinds = new Set(["utterance", "run-heartbeat", "run-timing"]);
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

test("provenance refs are mechanical projections of the same durable facts", () => {
	const merged = renderFeedItem(createLedgerEvent({ seq: 3, kind: "pr-merged", at: 1, payload: { runId: "run-1", intentId: "intent-1", prNumber: 7, mergeSha: "e".repeat(40) } }));
	assert.deepEqual(merged.refs, { prNumber: 7, sha: "e".repeat(40) }, "the PR and commit ride as structured refs");
	const observed = renderFeedItem(createLedgerEvent({ seq: 4, kind: "deploy-observed", at: 1, payload: { sha: "b".repeat(40) } }));
	assert.deepEqual(observed.refs, { sha: "b".repeat(40) });
	const chat = renderFeedItem(createLedgerEvent({ seq: 5, kind: "intent-opened", at: 1, payload: { intentId: "intent-1", by: "callil" } }));
	assert.equal(chat.refs, undefined, "kinds without artifacts carry no refs");
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

test("pipeline chips stay active through every phase, not just while queued", () => {
	// The outage this guards: the projection only rendered QUEUED runs, so the
	// dock's active count dropped to zero the moment a build started — minutes
	// before the change was live — and read as "your edit never landed".
	let queue = enqueueRun([], { runId: "run-1", intentId: "intent-1", enqueuedAt: 0 });
	queue = startRun(queue, { runId: "run-1", attemptId: "attempt-1", startedAt: 0 });
	queue = enqueueRun(queue, { runId: "run-2", intentId: "intent-2", enqueuedAt: 1 });

	const chips = renderQueueChips(queue, 60_000);
	assert.equal(chips.length, 2, "a running build is still active work");
	const running = chips.find((chip) => chip.runId === "run-1");
	assert.equal(running.phase, "building", "the running phase is named for the user");
	const queued = chips.find((chip) => chip.runId === "run-2");
	assert.equal(queued.phase, "queued");
	assert.equal(queued.position, 1);
	assert.equal(queued.label, "#1 in line · ~4 min");

	// verifying and deploying remain visibly active until the terminal fact.
	queue = beginVerifying(queue, { runId: "run-1", attemptId: "attempt-1", at: 61_000, verification: { branch: "room/1/a", prNumber: 7, headSha: "a".repeat(40) } });
	assert.equal(renderQueueChips(queue, 62_000).find((chip) => chip.runId === "run-1").phase, "verifying");
	queue = beginDeploying(queue, { runId: "run-1", attemptId: "attempt-1", at: 63_000, mergeSha: "b".repeat(40) });
	assert.equal(renderQueueChips(queue, 64_000).find((chip) => chip.runId === "run-1").phase, "deploying");

	// Terminal states leave the pipeline.
	queue = completeRun(queue, { runId: "run-1", attemptId: "attempt-1", state: "merged", at: 65_000 });
	const after = renderQueueChips(queue, 66_000);
	assert.equal(after.find((chip) => chip.runId === "run-1"), undefined, "a merged (live) run is no longer active");

	const feed = renderFeed({ events: [], queue, now: 66_000, frozen: true });
	assert.deepEqual(feed.queue, after, "pipeline state is embedded in the feed payload");
	assert.equal(feed.frozen, true);
});

test("accepted intents count as active before their run exists, and reviewing intents after a failed one", () => {
	const openIntent = { id: "intent-open", state: "open", openedAt: 5 };
	const reviewing = { id: "intent-review", state: "dispatched", openedAt: 1 };
	const done = { id: "intent-done", state: "live", openedAt: 0 };
	const chips = renderQueueChips([], 10_000, [openIntent, reviewing, done]);
	assert.equal(chips.length, 2, "terminal intents are not active");
	assert.equal(chips.find((chip) => chip.intentId === "intent-open").phase, "accepted", "a request is visibly active from the moment it is accepted");
	assert.equal(chips.find((chip) => chip.intentId === "intent-review").phase, "reviewing", "a dispatched intent between runs stays honestly visible");

	// An intent whose run is in the queue projects through the run, never twice.
	let queue = enqueueRun([], { runId: "run-9", intentId: "intent-open", enqueuedAt: 0 });
	const merged = renderQueueChips(queue, 10_000, [openIntent]);
	assert.equal(merged.length, 1, "one chip per intent");
	assert.equal(merged[0].phase, "queued");
});

test("chips carry the intent's identity: anchor, verbatim request, requester", () => {
	// A room member should read WHAT is building at a glance, and clients can
	// pin pending work to the exact element it targets.
	const decorated = {
		id: "intent-x", state: "open", openedAt: 1,
		anchor: { kind: "target", dataLoc: "src/ui/page.html:42:3", selector: "button.checkout", selectorPath: ".checkout" },
		requestText: "Make it pop",
		requestedBy: "Ada",
	};
	const [chip] = renderQueueChips([], 10_000, [decorated]);
	assert.equal(chip.anchor.dataLoc, "src/ui/page.html:42:3", "the anchor rides the chip");
	assert.equal(chip.text, "Make it pop", "the verbatim request rides the chip");
	assert.equal(chip.by, "Ada", "the requester rides the chip");

	// The same identity rides when the intent's run is in the queue.
	const queue = enqueueRun([], { runId: "run-x", intentId: "intent-x", enqueuedAt: 0 });
	const [queuedChip] = renderQueueChips(queue, 10_000, [{ ...decorated, state: "dispatched" }]);
	assert.equal(queuedChip.phase, "queued");
	assert.equal(queuedChip.text, "Make it pop");
	assert.equal(queuedChip.anchor.selector, "button.checkout");

	// Long request text is clipped for the chip, never a wall of text.
	const wordy = { ...decorated, id: "intent-y", requestText: "x".repeat(400) };
	const [clipped] = renderQueueChips([], 10_000, [wordy]);
	assert.ok(clipped.text.length <= 121, "chip text is bounded");
});

test("ETAs read as estimates", () => {
	assert.equal(formatEta(30_000), "under a minute");
	assert.equal(formatEta(5 * 60_000), "~5 min");
	assert.throws(() => formatEta(-1), /non-negative/u);
});
