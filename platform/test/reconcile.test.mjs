import assert from "node:assert/strict";
import test from "node:test";
import { CANCEL_WINDOW_MS } from "../contracts/envelope.js";
import { beginDeploying, beginVerifying, DEPLOY_TTL_MS, enqueueRun, RUN_TTL_MS, startRun } from "../contracts/queue.js";
import { decide } from "../contracts/reconcile.js";

const BUDGET_OK = { spentUsd: 0, budgetUsd: 25, estimatedRunUsd: 0.75 };
const BUDGET_SPENT = { spentUsd: 25, budgetUsd: 25, estimatedRunUsd: 0.75 };
const VERIFICATION = { branch: "room/12/abcd1234", prNumber: 7, headSha: "a".repeat(40) };
const MERGE_SHA = "b".repeat(40);

function snapshot(overrides = {}) {
	return { now: 1_000_000, frozen: false, queue: [], openIntents: [], budget: BUDGET_OK, revert: null, watchdog: null, ...overrides };
}

test("an idle room decides nothing", () => {
	assert.deepEqual(decide(snapshot()), []);
});

test("an open intent dispatches only after its cancel window fully elapses", () => {
	const openedAt = 1_000_000;
	const before = decide(snapshot({ now: openedAt + CANCEL_WINDOW_MS - 1, openIntents: [{ id: "intent-1", openedAt }] }));
	assert.deepEqual(before, [], "inside the window the request is still cancellable");
	const after = decide(snapshot({ now: openedAt + CANCEL_WINDOW_MS, openIntents: [{ id: "intent-1", openedAt }] }));
	assert.deepEqual(after, [{ kind: "enqueue-intent", intentId: "intent-1" }]);
});

test("the FIFO head dispatches when the lane is free, the room unfrozen, and the budget ok", () => {
	const queue = enqueueRun([], { runId: "run-1", intentId: "intent-1", enqueuedAt: 1 });
	assert.deepEqual(decide(snapshot({ queue })), [{ kind: "dispatch", runId: "run-1", intentId: "intent-1" }]);
	assert.deepEqual(decide(snapshot({ queue, frozen: true })), [], "a frozen room dispatches nothing");
	assert.deepEqual(decide(snapshot({ queue, budget: BUDGET_SPENT })), [{ kind: "announce-budget-exhausted" }], "an exhausted budget is a recorded state, not a silent stall");
});

test("one run at a time: an active run blocks dispatch of the next head", () => {
	let queue = enqueueRun([], { runId: "run-1", intentId: "intent-1", enqueuedAt: 1 });
	queue = enqueueRun(queue, { runId: "run-2", intentId: "intent-2", enqueuedAt: 2 });
	queue = startRun(queue, { runId: "run-1", attemptId: "attempt-1", startedAt: 999_999 });
	const actions = decide(snapshot({ queue }));
	assert.ok(!actions.some((action) => action.kind === "dispatch"), "the lane is busy");
});

test("a verifying run is observed against CI at its exact recorded head SHA", () => {
	let queue = enqueueRun([], { runId: "run-1", intentId: "intent-1", enqueuedAt: 1 });
	queue = startRun(queue, { runId: "run-1", attemptId: "attempt-1", startedAt: 999_000 });
	queue = beginVerifying(queue, { runId: "run-1", attemptId: "attempt-1", at: 999_500, verification: VERIFICATION });
	assert.deepEqual(decide(snapshot({ queue })), [
		{ kind: "observe-ci", runId: "run-1", attemptId: "attempt-1", prNumber: 7, headSha: VERIFICATION.headSha },
	]);
});

test("a deploying run is observed against the product /version endpoint", () => {
	let queue = enqueueRun([], { runId: "run-1", intentId: "intent-1", enqueuedAt: 1 });
	queue = startRun(queue, { runId: "run-1", attemptId: "attempt-1", startedAt: 999_000 });
	queue = beginVerifying(queue, { runId: "run-1", attemptId: "attempt-1", at: 999_500, verification: VERIFICATION });
	queue = beginDeploying(queue, { runId: "run-1", attemptId: "attempt-1", at: 999_900, mergeSha: MERGE_SHA });
	assert.deepEqual(decide(snapshot({ queue })), [
		{ kind: "observe-deploy", runId: "run-1", attemptId: "attempt-1", mergeSha: MERGE_SHA },
	]);
});

test("an expired run parks first and the freed lane dispatches the next head in the SAME cycle", () => {
	let queue = enqueueRun([], { runId: "run-1", intentId: "intent-1", enqueuedAt: 0 });
	queue = enqueueRun(queue, { runId: "run-2", intentId: "intent-2", enqueuedAt: 1 });
	queue = startRun(queue, { runId: "run-1", attemptId: "attempt-1", startedAt: 0 });
	const actions = decide(snapshot({ now: RUN_TTL_MS }));
	assert.deepEqual(actions, [], "sanity: an empty snapshot still decides nothing");
	const expired = decide(snapshot({ now: RUN_TTL_MS, queue }));
	assert.deepEqual(expired, [
		{ kind: "park-run", runId: "run-1", intentId: "intent-1", phase: "running" },
		{ kind: "dispatch", runId: "run-2", intentId: "intent-2" },
	]);
});

test("a merged-but-unobserved deploy parks on the deploy clock, naming its phase", () => {
	let queue = enqueueRun([], { runId: "run-1", intentId: "intent-1", enqueuedAt: 0 });
	queue = startRun(queue, { runId: "run-1", attemptId: "attempt-1", startedAt: 0 });
	queue = beginVerifying(queue, { runId: "run-1", attemptId: "attempt-1", at: 100, verification: VERIFICATION });
	queue = beginDeploying(queue, { runId: "run-1", attemptId: "attempt-1", at: 200, mergeSha: MERGE_SHA });
	const actions = decide(snapshot({ now: 200 + DEPLOY_TTL_MS, queue }));
	assert.equal(actions[0].kind, "park-run");
	assert.equal(actions[0].phase, "deploying");
});

test("an owner revert outranks everything and suppresses nothing else mechanical", () => {
	const queue = enqueueRun([], { runId: "run-1", intentId: "intent-1", enqueuedAt: 1 });
	const first = decide(snapshot({ queue, revert: { sha: MERGE_SHA, dispatchedAt: null } }));
	assert.deepEqual(first[0], { kind: "dispatch-revert", sha: MERGE_SHA });
	const observing = decide(snapshot({ queue, revert: { sha: MERGE_SHA, dispatchedAt: 999_000 } }));
	assert.deepEqual(observing[0], { kind: "observe-revert", sha: MERGE_SHA });
	assert.ok(first.some((action) => action.kind === "dispatch"), "the build queue still advances during a revert");
});

test("the liveness window checks every cycle, but never while a revert is already in flight", () => {
	const watchdog = { sha: MERGE_SHA, until: 1_000_500, migration: false };
	const during = decide(snapshot({ watchdog }));
	assert.deepEqual(during, [{ kind: "liveness-check", sha: MERGE_SHA, migration: false }]);
	const expired = decide(snapshot({ now: 1_000_500, watchdog }));
	assert.deepEqual(expired, [], "the window closes on its own clock");
	const reverting = decide(snapshot({ watchdog, revert: { sha: MERGE_SHA, dispatchedAt: null } }));
	assert.ok(!reverting.some((action) => action.kind === "liveness-check"), "one deterministic recovery at a time");
});

test("the migration marker rides the liveness decision so the executor can refuse auto-revert", () => {
	const actions = decide(snapshot({ watchdog: { sha: MERGE_SHA, until: 1_000_500, migration: true } }));
	assert.deepEqual(actions, [{ kind: "liveness-check", sha: MERGE_SHA, migration: true }]);
});

test("the policy is a pure function: the same snapshot always yields the same plan", () => {
	let queue = enqueueRun([], { runId: "run-1", intentId: "intent-1", enqueuedAt: 1 });
	queue = enqueueRun(queue, { runId: "run-2", intentId: "intent-2", enqueuedAt: 2 });
	const shot = snapshot({ queue, openIntents: [{ id: "intent-3", openedAt: 1 }], watchdog: { sha: MERGE_SHA, until: 2_000_000, migration: false } });
	assert.deepEqual(decide(shot), decide(shot));
	assert.throws(() => decide(snapshot({ now: -1 })), /non-negative/u);
});

test("a pending Doctor case consults exactly once per cycle, ahead of dispatch, without blocking the lane", () => {
	const queue = enqueueRun([], { runId: "run-2", intentId: "intent-2", enqueuedAt: 1 });
	const actions = decide(snapshot({ queue, doctorQueue: [{ id: "case-1", kind: "ci-red", intentId: "intent-1", detail: "CI failed", at: 1 }] }));
	assert.deepEqual(actions[0], { kind: "consult-doctor" }, "the case resolves before new work");
	assert.equal(actions.filter((action) => action.kind === "consult-doctor").length, 1, "one consult per cycle");
	assert.ok(actions.some((action) => action.kind === "dispatch"), "a pending case never blocks the free lane");
	assert.deepEqual(decide(snapshot({ doctorQueue: [] })), [], "an empty doctor queue decides nothing");
});
