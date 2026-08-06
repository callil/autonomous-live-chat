import assert from "node:assert/strict";
import {
	applyCoordinatorCallback,
	claimCoordinatorEffect,
	completeCoordinatorEffect,
	createCoordinatorEffect,
	createCoordinatorJob,
	normalizeAgentProvenance,
	reconcileCompletedStack,
	retryCoordinatorEffect,
} from "../src/coordinator-state.js";
import { applyStackEvent, createStackLedger, validateStackLedger } from "../src/stack-ledger.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

function records(id, now = 1_000) {
	const effectId = `${id}-create`;
	return {
		job: createCoordinatorJob({ workflowId: id, workItemId: `${id}-item`, pipeline: "os-native-git", firstEffectId: effectId, now }),
		effect: createCoordinatorEffect({ id: effectId, jobId: id, workItemId: `${id}-item`, kind: "create-issue", now }),
	};
}

// Concurrent intake: independent work owns independent leases; no singleton admission record exists.
{
	const first = records("workflow-one");
	const second = records("workflow-two");
	const claimedFirst = claimCoordinatorEffect(first.job, first.effect, { now: 1_001, leaseToken: "lease-one", leaseMs: 100 });
	const claimedSecond = claimCoordinatorEffect(second.job, second.effect, { now: 1_001, leaseToken: "lease-two", leaseMs: 100 });
	assert.equal(claimedFirst.disposition, "claimed");
	assert.equal(claimedSecond.disposition, "claimed");
	assert.notEqual(claimedFirst.job.id, claimedSecond.job.id);
	const auxiliary = createCoordinatorEffect({ id: "workflow-one-status", jobId: first.job.id, workItemId: first.job.workItemId, kind: "github-status", now: 1_001, blocking: false });
	assert.equal(claimCoordinatorEffect(claimedFirst.job, auxiliary, { now: 1_002, leaseToken: "lease-status", leaseMs: 100 }).disposition, "busy");
}

// Idempotent retry: an expired attempt cannot complete after a retry has been made available.
{
	const initial = records("workflow-retry");
	const first = claimCoordinatorEffect(initial.job, initial.effect, { now: 1_000, leaseToken: "lease-old", leaseMs: 50 });
	const retry = retryCoordinatorEffect(first.job, first.effect, { leaseToken: "lease-old", now: 1_010, availableAt: 1_020 });
	assert.equal(retry.disposition, "retrying");
	assert.equal(completeCoordinatorEffect(retry.job, retry.effect, { leaseToken: "lease-old", now: 1_011 }).disposition, "stale");
	const second = claimCoordinatorEffect(retry.job, retry.effect, { now: 1_020, leaseToken: "lease-new", leaseMs: 50 });
	assert.equal(second.disposition, "claimed");
	const completed = completeCoordinatorEffect(second.job, second.effect, { leaseToken: "lease-new", now: 1_021, nextStage: "awaiting-callback" });
	assert.equal(completed.disposition, "completed");
	assert.equal(completeCoordinatorEffect(completed.job, completed.effect, { leaseToken: "lease-new", now: 1_022 }).disposition, "duplicate");
}

// Lease expiry: another alarm can reclaim the same effect only after the durable deadline.
{
	const initial = records("workflow-lease");
	const first = claimCoordinatorEffect(initial.job, initial.effect, { now: 2_000, leaseToken: "lease-first", leaseMs: 100 });
	assert.equal(claimCoordinatorEffect(first.job, first.effect, { now: 2_099, leaseToken: "lease-early", leaseMs: 100 }).disposition, "busy");
	const reclaimed = claimCoordinatorEffect(first.job, first.effect, { now: 2_100, leaseToken: "lease-reclaimed", leaseMs: 100 });
	assert.equal(reclaimed.disposition, "claimed");
	assert.equal(reclaimed.effect.attempts, 2);
}

// A superseded blocking effect cannot resume and overwrite a later OS
// capability handoff after asynchronous I/O interleaves.
{
	const initial = records("workflow-superseded");
	const advancedJob = { ...initial.job, currentEffectId: "workflow-superseded-observe-main", stage: "queued", lease: null };
	assert.equal(claimCoordinatorEffect(advancedJob, initial.effect, { now: 2_200, leaseToken: "stale-lease", leaseMs: 100 }).disposition, "stale");
}

// Exhausting an App-bot status retry records that delivery failure without falsifying core workflow authority.
{
	const initial = records("workflow-status");
	const status = createCoordinatorEffect({ id: "workflow-status-effect", jobId: initial.job.id, workItemId: initial.job.workItemId, kind: "github-status", now: 2_500, blocking: false });
	const claimed = claimCoordinatorEffect(initial.job, status, { now: 2_500, leaseToken: "status-lease", leaseMs: 100 });
	const failed = retryCoordinatorEffect(claimed.job, claimed.effect, { leaseToken: "status-lease", now: 2_501, availableAt: 2_501, terminal: true });
	assert.equal(failed.disposition, "failed");
	assert.equal(failed.job.stage, "queued");
	assert.equal(failed.job.terminalPhase, undefined);
}

// Terminal absorption: completion wins once, duplicate delivery is harmless, and late failure cannot reopen it.
{
	const initial = records("workflow-terminal");
	const completed = applyCoordinatorCallback(initial.job, { callbackKey: "completed-run-42", phase: "completed", now: 3_000 });
	assert.equal(completed.disposition, "applied");
	assert.equal(completed.job.stage, "terminal");
	assert.equal(applyCoordinatorCallback(completed.job, { callbackKey: "completed-run-42", phase: "completed", now: 3_001 }).disposition, "duplicate");
	assert.equal(applyCoordinatorCallback(completed.job, { callbackKey: "failed-run-42", phase: "failed", now: 3_002 }).disposition, "stale");
}

// Signed completion callback provenance deterministically closes the stack and issue authority.
{
	let ledger = createStackLedger({
		id: "stack-completion",
		repository: "callil/autonomous-live-chat",
		lane: "room-main",
		issue: { number: 42, url: "https://github.com/callil/autonomous-live-chat/issues/42" },
		baseSha: A,
		nodes: [{ id: "root", intent: "Use the blue accent", branchPrefix: "app-harness-os/42" }],
	});
	ledger = applyStackEvent(ledger, { type: "runner-attempt-started", eventId: "runner-start", generation: 1, nodeId: "root", attemptToken: "runner-token" }).ledger;
	ledger = applyStackEvent(ledger, { type: "runner-candidate-recorded", eventId: "runner-candidate", generation: 1, nodeId: "root", attemptToken: "runner-token", parentBranch: "main", parentBaseSha: A, headSha: B, pullRequestNumber: 7, pullRequestUrl: "https://github.com/callil/autonomous-live-chat/pull/7" }).ledger;
	const completed = reconcileCompletedStack(ledger, { currentMainSha: A, headSha: B, mergeSha: C, deploymentUrl: "https://example.workers.dev/", runId: "12345" });
	assert.equal(completed.status, "completed");
	assert.equal(completed.issue.authority, "completed");
	assert.equal(completed.nodes[0].state, "merged");
	assert.equal(completed.deployment.deploymentUrl, "https://example.workers.dev/");
	assert.deepEqual(reconcileCompletedStack(completed, { currentMainSha: A, headSha: B, mergeSha: C, deploymentUrl: "https://example.workers.dev/", runId: "12345" }), completed);
	validateStackLedger(completed);
}

// Runner audit storage is allowlisted and bounded; no arbitrary payload survives normalization.
{
	const provenance = normalizeAgentProvenance({ model: "gpt-5.6-codex", responseIds: ["resp_1", "resp_1", "bad value"], tools: ["read_doc", "apply_patch"], prompt: "secret", output: "secret", diff: "secret" });
	assert.deepEqual(provenance, { model: "gpt-5.6-codex", responseIds: ["resp_1"], tools: ["read_doc", "apply_patch"] });
	assert.deepEqual(Object.keys(provenance), ["model", "responseIds", "tools"]);
}

console.log("durable coordinator tests passed");
