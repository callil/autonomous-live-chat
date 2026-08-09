import assert from "node:assert/strict";
import test from "node:test";
import {
	activeRun,
	assertLiveAttempt,
	AVERAGE_RUN_MS,
	beginDeploying,
	beginVerifying,
	completeRun,
	DEPLOY_TTL_MS,
	enqueueRun,
	nextDispatch,
	parkExpiredRun,
	pruneTerminalRuns,
	queueStatus,
	RUN_TTL_MS,
	startRun,
	validateVerification,
	VERIFY_TTL_MS,
	withinDailyBudget,
} from "../contracts/queue.js";

const VERIFICATION = { branch: "room/12/abcd1234", prNumber: 7, headSha: "a".repeat(40) };
const MERGE_SHA = "b".repeat(40);

test("strict FIFO with no coalescing: runs dispatch one at a time in arrival order", () => {
	let queue = enqueueRun([], { runId: "run-a", intentId: "intent-a", enqueuedAt: 1 });
	queue = enqueueRun(queue, { runId: "run-b", intentId: "intent-b", enqueuedAt: 2 });
	queue = enqueueRun(queue, { runId: "run-c", intentId: "intent-c", enqueuedAt: 3 });
	assert.equal(nextDispatch(queue)?.runId, "run-a");
	queue = startRun(queue, { runId: "run-a", attemptId: "attempt-1", startedAt: 10 });
	assert.equal(nextDispatch(queue), null, "singleton runs: nothing dispatches while a run is active");
	assert.throws(() => startRun(queue, { runId: "run-b", attemptId: "attempt-2", startedAt: 11 }), /not the dispatchable head/u);
	queue = completeRun(queue, { runId: "run-a", attemptId: "attempt-1", state: "failed", at: 20 });
	assert.equal(nextDispatch(queue)?.runId, "run-b", "the queue advances in FIFO order");
});

test("duplicate admission is a loud caller bug", () => {
	const queue = enqueueRun([], { runId: "run-a", intentId: "intent-a", enqueuedAt: 1 });
	assert.throws(() => enqueueRun(queue, { runId: "run-a", intentId: "intent-z", enqueuedAt: 2 }), /already recorded/u);
	assert.throws(() => enqueueRun(queue, { runId: "run-b", intentId: "intent-a", enqueuedAt: 2 }), /non-terminal run/u);
});

test("transitions: queued -> running -> verifying -> deploying -> merged, attempt-guarded", () => {
	let queue = enqueueRun([], { runId: "run-a", intentId: "intent-a", enqueuedAt: 1 });
	assert.throws(() => beginVerifying(queue, { runId: "run-a", attemptId: "attempt-1", at: 2, verification: VERIFICATION }), /queued; late results are inert/u);
	queue = startRun(queue, { runId: "run-a", attemptId: "attempt-1", startedAt: 2 });
	assert.equal(activeRun(queue)?.state, "running");
	queue = beginVerifying(queue, { runId: "run-a", attemptId: "attempt-1", at: 3, verification: VERIFICATION });
	assert.equal(activeRun(queue)?.state, "verifying");
	assert.deepEqual(activeRun(queue)?.verification, VERIFICATION, "the exact SHA recorded now is the only revision that may merge");
	queue = beginDeploying(queue, { runId: "run-a", attemptId: "attempt-1", at: 4, mergeSha: MERGE_SHA, migration: false });
	assert.equal(activeRun(queue)?.state, "deploying", "a squash-merged run stays active until its deploy is observed");
	queue = completeRun(queue, { runId: "run-a", attemptId: "attempt-1", state: "merged", at: 5, detail: MERGE_SHA });
	assert.equal(activeRun(queue), null);
	assert.equal(queue[0].state, "merged");
});

test("verification context is validated: branch, PR number, exact 40-hex head SHA", () => {
	assert.deepEqual(validateVerification(VERIFICATION), VERIFICATION);
	assert.throws(() => validateVerification({ ...VERIFICATION, headSha: "abc" }), /40-hex/u);
	assert.throws(() => validateVerification({ ...VERIFICATION, prNumber: 0 }), /PR number/u);
	assert.throws(() => validateVerification({ ...VERIFICATION, branch: "-evil" }), /branch/u);
});

test("merged is earned, never claimed: only a deploying run completes merged, and a deploying run cannot fail", () => {
	let queue = enqueueRun([], { runId: "run-a", intentId: "intent-a", enqueuedAt: 1 });
	queue = startRun(queue, { runId: "run-a", attemptId: "attempt-1", startedAt: 2 });
	assert.throws(() => completeRun(queue, { runId: "run-a", attemptId: "attempt-1", state: "merged", at: 3 }), /observed deploy/u, "a running run cannot claim merged");
	queue = beginVerifying(queue, { runId: "run-a", attemptId: "attempt-1", at: 3, verification: VERIFICATION });
	assert.throws(() => completeRun(queue, { runId: "run-a", attemptId: "attempt-1", state: "merged", at: 4 }), /observed deploy/u, "a verifying run cannot claim merged");
	assert.throws(() => beginDeploying(queue, { runId: "run-a", attemptId: "attempt-1", at: 4, mergeSha: "short" }), /squash-merge commit SHA/u);
	queue = beginDeploying(queue, { runId: "run-a", attemptId: "attempt-1", at: 4, mergeSha: MERGE_SHA });
	assert.throws(() => completeRun(queue, { runId: "run-a", attemptId: "attempt-1", state: "failed", at: 5 }), /parks loudly/u, "a deploying run's merge already landed; it can never quietly fail");
});

test("zombie-proofing: a superseded attempt's push is inert", () => {
	let queue = enqueueRun([], { runId: "run-a", intentId: "intent-a", enqueuedAt: 1 });
	queue = startRun(queue, { runId: "run-a", attemptId: "attempt-2", startedAt: 2 });
	assert.throws(() => assertLiveAttempt(queue, { runId: "run-a", attemptId: "attempt-1" }), /superseded attempt/u);
	assert.throws(() => completeRun(queue, { runId: "run-a", attemptId: "attempt-1", state: "failed", at: 3 }), /superseded attempt/u);
	queue = completeRun(queue, { runId: "run-a", attemptId: "attempt-2", state: "failed", at: 3, detail: "ci-red" });
	assert.throws(() => assertLiveAttempt(queue, { runId: "run-a", attemptId: "attempt-2" }), /late results are inert/u, "terminal runs accept nothing further");
});

test("each phase runs on its own clock: build, verify, and deploy budgets park from their own start marks", () => {
	let queue = enqueueRun([], { runId: "run-a", intentId: "intent-a", enqueuedAt: 0 });
	queue = enqueueRun(queue, { runId: "run-b", intentId: "intent-b", enqueuedAt: 1 });
	queue = startRun(queue, { runId: "run-a", attemptId: "attempt-1", startedAt: 0 });
	const early = parkExpiredRun(queue, RUN_TTL_MS - 1);
	assert.equal(early.parked, null, "a run inside its build budget is untouched");
	const { queue: swept, parked } = parkExpiredRun(queue, RUN_TTL_MS);
	assert.equal(parked?.runId, "run-a");
	assert.equal(swept.find((run) => run.runId === "run-a")?.state, "parked");
	assert.equal(swept.find((run) => run.runId === "run-a")?.detail, "running-ttl-exceeded", "the parked detail names the expired phase");
	assert.equal(nextDispatch(swept)?.runId, "run-b", "parking advances the queue");

	// Reaching verifying at the edge of the build budget earns a fresh CI clock.
	let verifying = beginVerifying(queue, { runId: "run-a", attemptId: "attempt-1", at: RUN_TTL_MS - 1, verification: VERIFICATION });
	assert.equal(parkExpiredRun(verifying, RUN_TTL_MS + 1).parked, null, "the build clock no longer applies");
	const verifyExpired = parkExpiredRun(verifying, RUN_TTL_MS - 1 + VERIFY_TTL_MS);
	assert.equal(verifyExpired.parked?.runId, "run-a");
	assert.equal(verifyExpired.queue.find((run) => run.runId === "run-a")?.detail, "verifying-ttl-exceeded");

	// A merged-but-unobserved deploy parks on the deploy clock with its own truth.
	let deploying = beginDeploying(verifying, { runId: "run-a", attemptId: "attempt-1", at: RUN_TTL_MS, mergeSha: MERGE_SHA });
	assert.equal(parkExpiredRun(deploying, RUN_TTL_MS + VERIFY_TTL_MS - 1).parked, null);
	const deployExpired = parkExpiredRun(deploying, RUN_TTL_MS + DEPLOY_TTL_MS);
	assert.equal(deployExpired.parked?.runId, "run-a");
	assert.equal(deployExpired.queue.find((run) => run.runId === "run-a")?.detail, "deploying-ttl-exceeded");
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
		queue = completeRun(queue, { runId: `run-${index}`, attemptId: `attempt-${index}`, state: "failed", at: index + 1 });
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
