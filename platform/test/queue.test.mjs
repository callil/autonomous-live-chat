import assert from "node:assert/strict";
import test from "node:test";
import {
	activeRun,
	assertLiveAttempt,
	AVERAGE_RUN_MS,
	beginVerifying,
	completeRun,
	enqueueRun,
	nextDispatch,
	parkExpiredRun,
	pruneTerminalRuns,
	queueStatus,
	RUN_TTL_MS,
	startRun,
	withinDailyBudget,
} from "../contracts/queue.js";

test("strict FIFO with no coalescing: runs dispatch one at a time in arrival order", () => {
	let queue = enqueueRun([], { runId: "run-a", intentId: "intent-a", enqueuedAt: 1 });
	queue = enqueueRun(queue, { runId: "run-b", intentId: "intent-b", enqueuedAt: 2 });
	queue = enqueueRun(queue, { runId: "run-c", intentId: "intent-c", enqueuedAt: 3 });
	assert.equal(nextDispatch(queue)?.runId, "run-a");
	queue = startRun(queue, { runId: "run-a", attemptId: "attempt-1", startedAt: 10 });
	assert.equal(nextDispatch(queue), null, "singleton runs: nothing dispatches while a run is active");
	assert.throws(() => startRun(queue, { runId: "run-b", attemptId: "attempt-2", startedAt: 11 }), /not the dispatchable head/u);
	queue = completeRun(queue, { runId: "run-a", attemptId: "attempt-1", state: "merged", at: 20 });
	assert.equal(nextDispatch(queue)?.runId, "run-b", "the queue advances in FIFO order");
});

test("duplicate admission is a loud caller bug", () => {
	const queue = enqueueRun([], { runId: "run-a", intentId: "intent-a", enqueuedAt: 1 });
	assert.throws(() => enqueueRun(queue, { runId: "run-a", intentId: "intent-z", enqueuedAt: 2 }), /already recorded/u);
	assert.throws(() => enqueueRun(queue, { runId: "run-b", intentId: "intent-a", enqueuedAt: 2 }), /non-terminal run/u);
});

test("transitions: queued -> running -> verifying -> merged, attempt-guarded", () => {
	let queue = enqueueRun([], { runId: "run-a", intentId: "intent-a", enqueuedAt: 1 });
	assert.throws(() => beginVerifying(queue, { runId: "run-a", attemptId: "attempt-1", at: 2 }), /queued; late results are inert/u);
	queue = startRun(queue, { runId: "run-a", attemptId: "attempt-1", startedAt: 2 });
	assert.equal(activeRun(queue)?.state, "running");
	queue = beginVerifying(queue, { runId: "run-a", attemptId: "attempt-1", at: 3 });
	assert.equal(activeRun(queue)?.state, "verifying");
	queue = completeRun(queue, { runId: "run-a", attemptId: "attempt-1", state: "merged", at: 4, detail: "a".repeat(40) });
	assert.equal(activeRun(queue), null);
	assert.equal(queue[0].state, "merged");
});

test("zombie-proofing: a superseded attempt's push is inert", () => {
	let queue = enqueueRun([], { runId: "run-a", intentId: "intent-a", enqueuedAt: 1 });
	queue = startRun(queue, { runId: "run-a", attemptId: "attempt-2", startedAt: 2 });
	assert.throws(() => assertLiveAttempt(queue, { runId: "run-a", attemptId: "attempt-1" }), /superseded attempt/u);
	assert.throws(() => completeRun(queue, { runId: "run-a", attemptId: "attempt-1", state: "merged", at: 3 }), /superseded attempt/u);
	queue = completeRun(queue, { runId: "run-a", attemptId: "attempt-2", state: "failed", at: 3, detail: "ci-red" });
	assert.throws(() => assertLiveAttempt(queue, { runId: "run-a", attemptId: "attempt-2" }), /late results are inert/u, "terminal runs accept nothing further");
});

test("10-minute TTL: park-and-explain, then the queue advances", () => {
	let queue = enqueueRun([], { runId: "run-a", intentId: "intent-a", enqueuedAt: 0 });
	queue = enqueueRun(queue, { runId: "run-b", intentId: "intent-b", enqueuedAt: 1 });
	queue = startRun(queue, { runId: "run-a", attemptId: "attempt-1", startedAt: 0 });
	const early = parkExpiredRun(queue, RUN_TTL_MS - 1);
	assert.equal(early.parked, null, "a run inside its budget is untouched");
	const { queue: swept, parked } = parkExpiredRun(queue, RUN_TTL_MS);
	assert.equal(parked?.runId, "run-a");
	assert.equal(swept.find((run) => run.runId === "run-a")?.state, "parked");
	assert.equal(nextDispatch(swept)?.runId, "run-b", "parking advances the queue");
});

test("honest queue state: position plus moving ETA", () => {
	let queue = enqueueRun([], { runId: "run-a", intentId: "intent-a", enqueuedAt: 0 });
	queue = enqueueRun(queue, { runId: "run-b", intentId: "intent-b", enqueuedAt: 1 });
	queue = enqueueRun(queue, { runId: "run-c", intentId: "intent-c", enqueuedAt: 2 });
	queue = startRun(queue, { runId: "run-a", attemptId: "attempt-1", startedAt: 0 });
	const status = queueStatus(queue, 60_000);
	assert.deepEqual(status.map((entry) => entry.position), [1, 2]);
	assert.equal(status[0].etaMs, AVERAGE_RUN_MS - 60_000, "the head's ETA is the active run's remaining budget");
	assert.equal(status[1].etaMs, AVERAGE_RUN_MS - 60_000 + AVERAGE_RUN_MS);
	const later = queueStatus(queue, 120_000);
	assert.ok(later[0].etaMs < status[0].etaMs, "the ETA moves as time passes");
});

test("terminal runs are pruned from the record, never from the ledger", () => {
	let queue = [];
	for (let index = 0; index < 30; index += 1) {
		queue = enqueueRun(queue, { runId: `run-${index}`, intentId: `intent-${index}`, enqueuedAt: index });
		queue = startRun(queue, { runId: `run-${index}`, attemptId: `attempt-${index}`, startedAt: index });
		queue = completeRun(queue, { runId: `run-${index}`, attemptId: `attempt-${index}`, state: "merged", at: index + 1 });
	}
	const pruned = pruneTerminalRuns(queue, 20);
	assert.equal(pruned.length, 20);
	assert.equal(pruned[0].runId, "run-10", "the oldest terminal records drop first");
});

test("the daily spend budget is enforced at dispatch", () => {
	assert.ok(withinDailyBudget({ spentUsd: 0, budgetUsd: 25, estimatedRunUsd: 0.75 }));
	assert.ok(withinDailyBudget({ spentUsd: 24.25, budgetUsd: 25, estimatedRunUsd: 0.75 }));
	assert.ok(!withinDailyBudget({ spentUsd: 24.5, budgetUsd: 25, estimatedRunUsd: 0.75 }));
	assert.throws(() => withinDailyBudget({ spentUsd: -1, budgetUsd: 25, estimatedRunUsd: 0.75 }), /non-negative/u);
});
