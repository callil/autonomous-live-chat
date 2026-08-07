import assert from "node:assert/strict";
import {
	applyStackEvent,
	branchForGeneration,
	createStackLedger,
	promotionKey,
	stackCancellationGroup,
	validateStackLedger,
} from "../orchestration/stack-ledger.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const E = "e".repeat(40);
const F = "f".repeat(40);
const ZERO = "0".repeat(40);
const ONE = "1".repeat(40);
const TWO = "2".repeat(40);

function singleLedger() {
	return createStackLedger({
		id: "stack-work-19",
		repository: "callil/autonomous-live-chat",
		lane: "room-main",
		issue: { number: 19, url: "https://github.com/callil/autonomous-live-chat/issues/19" },
		baseSha: A,
		nodes: [{ id: "root", intent: "change the accent", branchPrefix: "app-harness-os/19" }],
	});
}

function multiLedger() {
	return createStackLedger({
		id: "stack-work-42",
		repository: "callil/autonomous-live-chat",
		lane: "room-main",
		issue: { number: 42, url: "https://github.com/callil/autonomous-live-chat/issues/42" },
		baseSha: A,
		nativeStackId: "github-stack-42",
		nodes: [
			{ id: "slice-1", intent: "first", branchPrefix: "app-harness-os/42/01" },
			{ id: "slice-2", intent: "second", branchPrefix: "app-harness-os/42/02" },
			{ id: "slice-3", intent: "third", branchPrefix: "app-harness-os/42/03" },
		],
	});
}

function apply(ledger, event) {
	const outcome = applyStackEvent(ledger, event);
	assert.equal(outcome.disposition, "applied", outcome.reason);
	return outcome.ledger;
}

function stale(ledger, event, reason) {
	const outcome = applyStackEvent(ledger, event);
	assert.equal(outcome.disposition, "stale");
	assert.equal(outcome.reason, reason);
	assert.strictEqual(outcome.ledger, ledger);
}

function startRunner(ledger, eventId, nodeId, attemptToken) {
	return apply(ledger, { type: "runner-attempt-started", eventId, generation: ledger.generation, expectedRevision: ledger.revision, nodeId, attemptToken });
}

function recordCandidate(ledger, { eventId, nodeId, attemptToken, parentBranch, parentBaseSha, headSha, pullRequestNumber }) {
	return apply(ledger, {
		type: "runner-candidate-recorded",
		eventId,
		generation: ledger.generation,
		nodeId,
		attemptToken,
		parentBranch,
		parentBaseSha,
		headSha,
		pullRequestNumber,
		pullRequestUrl: `https://github.com/callil/autonomous-live-chat/pull/${pullRequestNumber}`,
	});
}

function validateNode(ledger, eventId, nodeId, headSha, outcome = "passed") {
	return apply(ledger, { type: "node-validation-recorded", eventId, generation: ledger.generation, nodeId, headSha, outcome });
}

function buildSingleCandidate() {
	let ledger = singleLedger();
	ledger = startRunner(ledger, "runner-start-1", "root", "attempt-one");
	ledger = recordCandidate(ledger, {
		eventId: "candidate-1",
		nodeId: "root",
		attemptToken: "attempt-one",
		parentBranch: "main",
		parentBaseSha: A,
		headSha: B,
		pullRequestNumber: 20,
	});
	return ledger;
}

// Creation establishes immutable issue/base ownership and derives the fast
// one-node policy instead of pretending an atomic request is a multi-node job.
{
	const ledger = singleLedger();
	assert.equal(ledger.mode, "one-node-stack");
	assert.equal(ledger.originalBaseSha, A);
	assert.equal(ledger.currentBaseSha, A);
	assert.equal(ledger.generationBaseSha, A);
	assert.equal(ledger.generation, 1);
	assert.equal(ledger.revision, 1);
	assert.equal(ledger.issue.authority, "active");
	assert.equal(ledger.nodes[0].branch, "app-harness-os/19/g1");
	assert.equal(ledger.nativeStack, null);
	assert.equal(stackCancellationGroup(ledger), "app-harness-stack-stack-work-19");
	assert.equal(branchForGeneration("app-harness-os/19", 7), "app-harness-os/19/g7");
}

// Creation rejects ambiguous authority and malformed or duplicate topology.
{
	assert.throws(() => createStackLedger({ id: "x", repository: "callil/other", lane: "main", issue: { number: 1, url: "https://github.com/callil/autonomous-live-chat/issues/1" }, baseSha: A, nodes: [{ id: "n", intent: "x", branchPrefix: "x/n" }] }));
	assert.throws(() => createStackLedger({ id: "x", repository: "callil/repo", lane: "main", issue: { number: 1, url: "https://github.com/callil/repo/issues/1" }, baseSha: "short", nodes: [{ id: "n", intent: "x", branchPrefix: "x/n" }] }));
	assert.throws(() => createStackLedger({ id: "x", repository: "callil/repo", lane: "main", issue: { number: 1, url: "https://github.com/callil/repo/issues/1" }, baseSha: A, nodes: [{ id: "n", intent: "x", branchPrefix: "x/n" }, { id: "n", intent: "y", branchPrefix: "x/m" }] }));
	assert.throws(() => createStackLedger({ id: "x", repository: "callil/repo", lane: "main", issue: { number: 1, url: "https://github.com/callil/repo/issues/1" }, baseSha: A, nativeStackId: "not-native", nodes: [{ id: "n", intent: "x", branchPrefix: "x/n" }] }));
	assert.throws(() => createStackLedger({ id: "x", repository: "callil/repo", lane: "main", issue: { number: 1, url: "https://github.com/callil/repo/issues/1" }, baseSha: A, nodes: [{ id: "n1", intent: "x", branchPrefix: "x/1" }, { id: "n2", intent: "y", branchPrefix: "x/2" }] }));
	assert.throws(() => branchForGeneration("bad..branch", 1));
}

// Ambiguous runner transport retries are correlated. A late attempt-one
// success cannot overwrite attempt two, while exact event replay is a no-op.
{
	let ledger = singleLedger();
	ledger = startRunner(ledger, "runner-start-1", "root", "attempt-one");
	ledger = apply(ledger, { type: "runner-attempt-retryable", eventId: "runner-retry-1", generation: 1, attemptToken: "attempt-one" });
	ledger = startRunner(ledger, "runner-start-2", "root", "attempt-two");
	stale(ledger, {
		type: "runner-candidate-recorded", eventId: "late-candidate", generation: 1, nodeId: "root", attemptToken: "attempt-one", parentBranch: "main", parentBaseSha: A, headSha: C, pullRequestNumber: 20, pullRequestUrl: "https://github.com/callil/autonomous-live-chat/pull/20",
	}, "runner-attempt-mismatch");
	const applied = recordCandidate(ledger, { eventId: "candidate-2", nodeId: "root", attemptToken: "attempt-two", parentBranch: "main", parentBaseSha: A, headSha: B, pullRequestNumber: 20 });
	assert.equal(applied.nodes[0].headSha, B);
	assert.equal(applied.runner.stage, "complete");
	const duplicate = applyStackEvent(applied, { type: "runner-candidate-recorded", eventId: "candidate-2", generation: 1 });
	assert.equal(duplicate.disposition, "duplicate");
	assert.strictEqual(duplicate.ledger, applied);
	stale(applied, { type: "runner-candidate-recorded", eventId: "late-again", generation: 1, nodeId: "root", attemptToken: "attempt-one" }, "runner-attempt-mismatch");
}

// Revision and generation fences reject callbacks from abandoned durable
// snapshots without consuming their event IDs or changing the revision.
{
	const ledger = singleLedger();
	stale(ledger, { type: "runner-attempt-started", eventId: "old-revision", generation: 1, expectedRevision: 99, nodeId: "root", attemptToken: "attempt" }, "revision-mismatch");
	stale(ledger, { type: "runner-attempt-started", eventId: "old-generation", generation: 2, nodeId: "root", attemptToken: "attempt" }, "generation-mismatch");
	assert.equal(ledger.revision, 1);
}

// The runner cannot silently move a node to a different parent or repository.
{
	let ledger = startRunner(singleLedger(), "runner-start", "root", "attempt");
	stale(ledger, { type: "runner-candidate-recorded", eventId: "wrong-base", generation: 1, nodeId: "root", attemptToken: "attempt", parentBranch: "main", parentBaseSha: C, headSha: B, pullRequestNumber: 20, pullRequestUrl: "https://github.com/callil/autonomous-live-chat/pull/20" }, "candidate-parent-mismatch");
	assert.throws(() => applyStackEvent(ledger, { type: "runner-candidate-recorded", eventId: "wrong-repo", generation: 1, nodeId: "root", attemptToken: "attempt", parentBranch: "main", parentBaseSha: A, headSha: B, pullRequestNumber: 20, pullRequestUrl: "https://github.com/other/repo/pull/20" }));
}

// Closing the authority issue is absorbing. No runner, main, CI, promotion,
// or deployment callback can revive cancelled work.
{
	let ledger = startRunner(singleLedger(), "runner-start", "root", "attempt");
	ledger = apply(ledger, { type: "issue-closed", eventId: "issue-close", generation: 1, issueNumber: 19, updatedAt: "2026-08-06T16:00:00Z" });
	assert.equal(ledger.status, "cancelled");
	assert.equal(ledger.issue.authority, "cancelled");
	assert.equal(ledger.nodes[0].state, "closed");
	for (const event of [
		{ type: "runner-candidate-recorded", eventId: "late-runner", generation: 1 },
		{ type: "main-observed", eventId: "late-main", generation: 1, mainSha: B },
		{ type: "deployment-succeeded", eventId: "late-deploy", generation: 1, attemptToken: "attempt", deploymentUrl: "https://example.com" },
	]) stale(ledger, event, "ledger-terminal");
}

// A fatal runner or CI result blocks once and cannot be overwritten by a
// same-generation success carrying a different event ID.
{
	let runnerFailed = startRunner(singleLedger(), "runner-start", "root", "attempt");
	runnerFailed = apply(runnerFailed, { type: "runner-attempt-failed", eventId: "runner-failed", generation: 1, attemptToken: "attempt" });
	assert.equal(runnerFailed.status, "blocked");
	assert.equal(runnerFailed.nodes[0].state, "failed");
	stale(runnerFailed, { type: "runner-candidate-recorded", eventId: "runner-late-success", generation: 1 }, "ledger-terminal");

	let ciFailed = buildSingleCandidate();
	ciFailed = validateNode(ciFailed, "ci-failed", "root", B, "failed");
	assert.equal(ciFailed.status, "blocked");
	assert.equal(ciFailed.nodes[0].state, "failed");
	stale(ciFailed, { type: "node-validation-recorded", eventId: "ci-late-pass", generation: 1, nodeId: "root", headSha: B, outcome: "passed" }, "ledger-terminal");
}

// A one-node stack with no candidate advances its root generation once when
// main moves, using the same root-led rule as a larger stack.
{
	let ledger = startRunner(singleLedger(), "runner-start-before-main", "root", "attempt-before-main");
	ledger = apply(ledger, { type: "main-observed", eventId: "main-moved-before-candidate", generation: 1, mainSha: C });
	assert.equal(ledger.status, "needs-restack");
	assert.equal(ledger.runner.stage, "restack-pending");
	ledger = apply(ledger, { type: "restack-started", eventId: "single-root-g2", generation: 1 });
	assert.equal(ledger.mode, "one-node-stack");
	assert.equal(ledger.generation, 2);
	assert.equal(ledger.generationBaseSha, C);
	assert.equal(ledger.nodes[0].branch, "app-harness-os/19/g2");
	assert.equal(ledger.nodes[0].parentBaseSha, C);
	assert.equal(ledger.runner.stage, "pending");
}

// A one-node stack keeps its immutable candidate generation/head when main
// advances. Only the integration proof and dispatch identity are invalidated.
{
	let ledger = validateNode(buildSingleCandidate(), "ci-pass", "root", B);
	const oldBranch = ledger.nodes[0].branch;
	const oldGeneration = ledger.generation;
	ledger = apply(ledger, { type: "main-observed", eventId: "main-b", generation: 1, mainSha: C });
	assert.equal(ledger.mode, "one-node-stack");
	assert.equal(ledger.generation, oldGeneration);
	assert.equal(ledger.nodes[0].branch, oldBranch);
	assert.equal(ledger.nodes[0].headSha, B);
	assert.equal(ledger.generationBaseSha, A);
	assert.equal(ledger.currentBaseSha, C);
	assert.equal(ledger.integration.required, true);
	stale(ledger, { type: "main-observed", eventId: "main-b-again", generation: 1, mainSha: C }, "main-unchanged");
	assert.throws(() => applyStackEvent(ledger, { type: "restack-started", eventId: "illegal-restack", generation: 1 }));
}

// Promotion is bound to generation + node + immutable head + observed main.
// A main advance invalidates an older dispatch and requires fresh integration.
{
	let ledger = validateNode(buildSingleCandidate(), "ci-pass", "root", B);
	const keyA = promotionKey(ledger.id, 1, "root", B, A);
	ledger = apply(ledger, { type: "promotion-planned", eventId: "promotion-plan-a", generation: 1, nodeId: "root", dispatchKey: keyA });
	ledger = apply(ledger, { type: "promotion-dispatched", eventId: "promotion-dispatch-a", generation: 1, dispatchKey: keyA, runId: "run-a" });
	ledger = apply(ledger, { type: "promotion-validated", eventId: "promotion-valid-a", generation: 1, dispatchKey: keyA, headSha: B, baseSha: A });
	assert.equal(ledger.integration.required, false);
	ledger = apply(ledger, { type: "main-observed", eventId: "main-c", generation: 1, mainSha: C });
	assert.equal(ledger.promotion.stage, "candidate-ready");
	stale(ledger, { type: "promotion-merge-started", eventId: "old-merge", generation: 1, dispatchKey: keyA, currentMainSha: A, headSha: B }, "promotion-not-currently-validated");
	const keyC = promotionKey(ledger.id, 1, "root", B, C);
	assert.notEqual(keyC, keyA);
	ledger = apply(ledger, { type: "promotion-planned", eventId: "promotion-plan-c", generation: 1, nodeId: "root", dispatchKey: keyC });
	stale(ledger, { type: "promotion-validated", eventId: "late-valid-a", generation: 1, dispatchKey: keyA, headSha: B, baseSha: A }, "promotion-dispatch-mismatch");
	ledger = apply(ledger, { type: "promotion-validated", eventId: "promotion-valid-c", generation: 1, dispatchKey: keyC, headSha: B, baseSha: C });
	stale(ledger, { type: "promotion-merge-started", eventId: "main-moved-again", generation: 1, dispatchKey: keyC, currentMainSha: D, headSha: B }, "promotion-final-provenance-mismatch");
}

// The complete one-node happy path is monotonic through merge and retryable
// deployment. A stale deploy attempt cannot complete the current attempt.
{
	let ledger = validateNode(buildSingleCandidate(), "ci-pass", "root", B);
	const key = promotionKey(ledger.id, 1, "root", B, A);
	ledger = apply(ledger, { type: "promotion-planned", eventId: "plan", generation: 1, nodeId: "root", dispatchKey: key });
	ledger = apply(ledger, { type: "promotion-dispatched", eventId: "dispatch", generation: 1, dispatchKey: key, runId: "run-1" });
	ledger = apply(ledger, { type: "promotion-validated", eventId: "validated", generation: 1, dispatchKey: key, headSha: B, baseSha: A });
	ledger = apply(ledger, { type: "promotion-merge-started", eventId: "merge-start", generation: 1, dispatchKey: key, currentMainSha: A, headSha: B });
	ledger = apply(ledger, { type: "promotion-merged", eventId: "merged", generation: 1, dispatchKey: key, headSha: B, mergeSha: C });
	assert.equal(ledger.nodes[0].state, "merged");
	assert.equal(ledger.deployment.stage, "pending");
	stale(ledger, { type: "deployment-attempt-started", eventId: "deploy-wrong-merge", generation: 1, attemptToken: "deploy-wrong", mergeSha: D }, "deployment-merge-mismatch");
	ledger = apply(ledger, { type: "deployment-attempt-started", eventId: "deploy-start-1", generation: 1, attemptToken: "deploy-one", mergeSha: C });
	ledger = apply(ledger, { type: "deployment-attempt-retryable", eventId: "deploy-retry", generation: 1, attemptToken: "deploy-one" });
	ledger = apply(ledger, { type: "deployment-attempt-started", eventId: "deploy-start-2", generation: 1, attemptToken: "deploy-two", mergeSha: C });
	stale(ledger, { type: "deployment-succeeded", eventId: "late-deploy-one", generation: 1, attemptToken: "deploy-one", deploymentUrl: "https://old.example.com" }, "deployment-attempt-mismatch");
	ledger = apply(ledger, { type: "deployment-succeeded", eventId: "deploy-success", generation: 1, attemptToken: "deploy-two", deploymentUrl: "https://autonomous-live-chat.example.com" });
	assert.equal(ledger.status, "completed");
	assert.equal(ledger.issue.authority, "completed");
	assert.equal(ledger.deployment.stage, "deployed");
	stale(ledger, { type: "deployment-failed", eventId: "late-deploy-failure", generation: 1, attemptToken: "deploy-two" }, "ledger-terminal");
	const duplicate = applyStackEvent(ledger, { type: "deployment-succeeded", eventId: "deploy-success", generation: 1 });
	assert.equal(duplicate.disposition, "duplicate");
}

// Closing a lower PR blocks its descendants and is absorbing.
{
	let ledger = multiLedger();
	ledger = startRunner(ledger, "start-1", "slice-1", "attempt-1");
	ledger = recordCandidate(ledger, { eventId: "candidate-1", nodeId: "slice-1", attemptToken: "attempt-1", parentBranch: "main", parentBaseSha: A, headSha: B, pullRequestNumber: 50 });
	ledger = apply(ledger, { type: "pull-request-closed", eventId: "pr-closed", generation: 1, nodeId: "slice-1", pullRequestNumber: 50, headSha: B });
	assert.equal(ledger.status, "blocked");
	assert.deepEqual(ledger.nodes.map((node) => node.state), ["closed", "blocked", "blocked"]);
	stale(ledger, { type: "main-observed", eventId: "main-after-close", generation: 1, mainSha: C }, "ledger-terminal");
}

// Multi-node candidates are accepted only in deterministic parent order. A
// lower merge advances main once; the remaining root starts exactly one new
// generation and descendants regenerate from their immediate parent heads.
{
	let ledger = multiLedger();
	assert.equal(ledger.mode, "multi-restack");
	assert.equal(ledger.nativeStack.id, "github-stack-42");
	assert.deepEqual(ledger.nativeStack.order, ["slice-1", "slice-2", "slice-3"]);
	assert.throws(() => startRunner(ledger, "out-of-order", "slice-2", "attempt-x"));
	ledger = startRunner(ledger, "start-1", "slice-1", "attempt-1");
	ledger = recordCandidate(ledger, { eventId: "candidate-1", nodeId: "slice-1", attemptToken: "attempt-1", parentBranch: "main", parentBaseSha: A, headSha: B, pullRequestNumber: 50 });
	ledger = startRunner(ledger, "start-2", "slice-2", "attempt-2");
	stale(ledger, { type: "runner-candidate-recorded", eventId: "child-wrong-parent", generation: 1, nodeId: "slice-2", attemptToken: "attempt-2", parentBranch: "main", parentBaseSha: A, headSha: C, pullRequestNumber: 51, pullRequestUrl: "https://github.com/callil/autonomous-live-chat/pull/51" }, "candidate-parent-mismatch");
	ledger = recordCandidate(ledger, { eventId: "candidate-2", nodeId: "slice-2", attemptToken: "attempt-2", parentBranch: ledger.nodes[0].branch, parentBaseSha: B, headSha: C, pullRequestNumber: 51 });
	ledger = startRunner(ledger, "start-3", "slice-3", "attempt-3");
	ledger = recordCandidate(ledger, { eventId: "candidate-3", nodeId: "slice-3", attemptToken: "attempt-3", parentBranch: ledger.nodes[1].branch, parentBaseSha: C, headSha: D, pullRequestNumber: 52 });
	ledger = validateNode(ledger, "validate-root", "slice-1", B);
	assert.throws(() => applyStackEvent(ledger, { type: "promotion-planned", eventId: "plan-before-native-sync", generation: 1, nodeId: "slice-1", dispatchKey: promotionKey(ledger.id, 1, "slice-1", B, A) }));
	ledger = apply(ledger, { type: "native-stack-sync-started", eventId: "native-sync-start-g1", generation: 1, attemptToken: "sync-g1" });
	stale(ledger, { type: "native-stack-reconciled", eventId: "wrong-native-order", generation: 1, nativeStackId: "github-stack-42", order: ["slice-2", "slice-1", "slice-3"], attemptToken: "sync-g1" }, "native-stack-order-mismatch");
	stale(ledger, { type: "native-stack-reconciled", eventId: "old-native-attempt", generation: 1, nativeStackId: "github-stack-42", order: ["slice-1", "slice-2", "slice-3"], attemptToken: "sync-old" }, "native-stack-attempt-mismatch");
	ledger = apply(ledger, { type: "native-stack-reconciled", eventId: "native-sync-g1", generation: 1, nativeStackId: "github-stack-42", order: ["slice-1", "slice-2", "slice-3"], attemptToken: "sync-g1" });
	assert.equal(ledger.nativeStack.stage, "synced");
	const key = promotionKey(ledger.id, 1, "slice-1", B, A);
	ledger = apply(ledger, { type: "promotion-planned", eventId: "plan-root", generation: 1, nodeId: "slice-1", dispatchKey: key });
	ledger = apply(ledger, { type: "promotion-validated", eventId: "valid-root", generation: 1, dispatchKey: key, headSha: B, baseSha: A });
	ledger = apply(ledger, { type: "promotion-merge-started", eventId: "merge-root-start", generation: 1, dispatchKey: key, currentMainSha: A, headSha: B });
	ledger = apply(ledger, { type: "promotion-merged", eventId: "merge-root", generation: 1, dispatchKey: key, headSha: B, mergeSha: E });
	assert.equal(ledger.status, "needs-restack");
	assert.equal(ledger.currentBaseSha, E);
	assert.deepEqual(ledger.nodes.map((node) => node.state), ["merged", "needs-restack", "needs-restack"]);
	assert.deepEqual(ledger.nativeStack.order, ["slice-2", "slice-3"]);
	assert.equal(ledger.nativeStack.stage, "pending");

	const beforeGeneration = ledger.generation;
	const restackEvent = { type: "restack-started", eventId: "restack-g2", generation: 1, expectedRevision: ledger.revision };
	ledger = apply(ledger, restackEvent);
	assert.equal(ledger.generation, beforeGeneration + 1);
	assert.equal(ledger.generationBaseSha, E);
	assert.equal(ledger.nativeStack.generation, 2);
	assert.equal(ledger.nativeStack.stage, "pending");
	assert.equal(ledger.nodes[0].generation, 1);
	assert.equal(ledger.nodes[1].generation, 2);
	assert.equal(ledger.nodes[1].branch, "app-harness-os/42/02/g2");
	assert.equal(ledger.nodes[1].parentBranch, "main");
	assert.equal(ledger.nodes[1].parentBaseSha, E);
	assert.equal(ledger.nodes[2].parentBranch, "app-harness-os/42/02/g2");
	assert.equal(ledger.nodes[2].parentBaseSha, null);
	const duplicate = applyStackEvent(ledger, restackEvent);
	assert.equal(duplicate.disposition, "duplicate");
	assert.equal(duplicate.ledger.generation, 2);
	assert.throws(() => applyStackEvent(ledger, { type: "restack-started", eventId: "restack-g3-too-early", generation: 2 }));

	ledger = startRunner(ledger, "g2-start-2", "slice-2", "g2-attempt-2");
	ledger = recordCandidate(ledger, { eventId: "g2-candidate-2", nodeId: "slice-2", attemptToken: "g2-attempt-2", parentBranch: "main", parentBaseSha: E, headSha: F, pullRequestNumber: 53 });
	ledger = startRunner(ledger, "g2-start-3", "slice-3", "g2-attempt-3");
	ledger = recordCandidate(ledger, { eventId: "g2-candidate-3", nodeId: "slice-3", attemptToken: "g2-attempt-3", parentBranch: ledger.nodes[1].branch, parentBaseSha: F, headSha: ZERO, pullRequestNumber: 54 });
	assert.equal(ledger.status, "active");
	assert.equal(ledger.nodes[2].parentBaseSha, F);
	ledger = apply(ledger, { type: "native-stack-sync-started", eventId: "native-sync-start-g2a", generation: 2, attemptToken: "sync-g2a" });
	ledger = apply(ledger, { type: "native-stack-sync-retryable", eventId: "native-sync-retry-g2", generation: 2, attemptToken: "sync-g2a" });
	ledger = apply(ledger, { type: "native-stack-sync-started", eventId: "native-sync-start-g2b", generation: 2, attemptToken: "sync-g2b" });
	stale(ledger, { type: "native-stack-reconciled", eventId: "native-sync-late-g2a", generation: 2, nativeStackId: "github-stack-42", order: ["slice-2", "slice-3"], attemptToken: "sync-g2a" }, "native-stack-attempt-mismatch");
	ledger = apply(ledger, { type: "native-stack-reconciled", eventId: "native-sync-g2", generation: 2, nativeStackId: "github-stack-42", order: ["slice-2", "slice-3"], attemptToken: "sync-g2b" });
	assert.equal(ledger.nativeStack.stage, "synced");
	stale(ledger, { type: "node-validation-recorded", eventId: "old-g1-ci", generation: 1, nodeId: "slice-2", headSha: C, outcome: "passed" }, "generation-mismatch");
}

// Main movement before any multi-node candidate creates one restack request.
// Re-observing the same SHA or replaying the start cannot create a CI loop.
{
	let ledger = multiLedger();
	ledger = apply(ledger, { type: "main-observed", eventId: "observe-b", generation: 1, mainSha: B });
	assert.equal(ledger.status, "needs-restack");
	assert.deepEqual(ledger.nodes.map((node) => node.state), ["needs-restack", "needs-restack", "needs-restack"]);
	stale(ledger, { type: "main-observed", eventId: "observe-b-again", generation: 1, mainSha: B }, "main-unchanged");
	const event = { type: "restack-started", eventId: "start-g2", generation: 1 };
	ledger = apply(ledger, event);
	assert.equal(ledger.generation, 2);
	assert.equal(applyStackEvent(ledger, event).disposition, "duplicate");
}

// Validation catches persisted corruption rather than letting it cross the
// Durable Object boundary.
{
	const ledger = structuredClone(singleLedger());
	ledger.nodes[0].branch = "someone-elses-branch";
	assert.throws(() => validateStackLedger(ledger));
	const wrongMode = structuredClone(singleLedger());
	wrongMode.mode = "multi-restack";
	assert.throws(() => validateStackLedger(wrongMode));
	assert.throws(() => applyStackEvent(singleLedger(), { type: "native-stack-sync-started", eventId: "fake-native-stack", generation: 1, attemptToken: "sync" }));
	assert.throws(() => promotionKey("stack", 1, "node", ONE, "not-a-sha"));
	assert.equal(promotionKey("stack", 1, "node", ONE, TWO).endsWith(TWO), true);
}

console.log("durable stack ledger contracts passed");
