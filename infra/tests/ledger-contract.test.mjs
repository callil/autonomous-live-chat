import assert from "node:assert/strict";
import {
	createLedgerWorkItem,
	implementationKey,
	LEDGER_PHASES,
	recordLedgerCandidate,
	recordLedgerClassification,
	recordLedgerExternalState,
	recordLedgerPlan,
	startLedgerImplementation,
} from "../../packages/contracts/ledger.js";

const SHA = "1".repeat(40);
const base = createLedgerWorkItem({ id: "work-1", room: "main", request: "Update the heading", now: 1 });

// Leases are gone: the per-item OperatorTurn Durable Object is the concurrency
// guarantee, so a work item carries no lease and no claim/defer machinery.
assert.equal(base.phase, "submitted");
assert.ok(!("lease" in base), "a work item carries no lease field");
assert.ok(!("resumeAt" in base), "a work item carries no defer/resume field");
assert.ok(!LEDGER_PHASES.includes("claimed"), "the claimed phase died with the lease machinery");

const classified = recordLedgerClassification(base, {
	classification: { decision: "eligible", changeType: "content", scope: "localized", risk: "low", affectedSurface: "copy", reversible: true, executionEligibility: "eligible", ciProfile: "content" },
	now: 3,
});
assert.equal(classified.phase, "classified");
assert.throws(() => recordLedgerClassification(classified, { classification: classified.classification, now: 4 }), /Only submitted work/u, "classification applies exactly once, straight from submitted");

const classifiedWithIssue = { ...classified, artifacts: { issue: { number: 1, url: "https://github.com/callil/autonomous-live-chat/issues/1" } } };
const planned = recordLedgerPlan(classifiedWithIssue, {
	plan: {
		revision: 1,
		baseSha: SHA,
		stackId: "stack-1",
		generation: 1,
		nodeId: "root",
		branch: "app-harness-os/1/g1",
		parentBranch: "main",
		parentBaseSha: SHA,
		pullRequestBase: "main",
		issueNumber: 1,
		summary: "Update heading",
		ciProfile: "content",
	},
	now: 4,
});
assert.equal(implementationKey(planned), `work-1:p1:g1:${SHA}`);

const started = startLedgerImplementation(planned, { runId: "run-1", now: 5 });
assert.equal(started.disposition, "started");
const duplicate = startLedgerImplementation(started.item, { runId: "run-1", now: 6 });
assert.equal(duplicate.disposition, "resume", "replaying the same attempt resumes instead of spawning duplicate coding-agent work");
// A FRESH runId is a deliberate restart: a dead or platform-killed run must be
// replaceable in place without waiting for a phase transition.
const restarted = startLedgerImplementation(started.item, { runId: "run-2", now: 7 });
assert.equal(restarted.disposition, "started", "a fresh runId restarts the implementation in place");
assert.equal(restarted.item.activeImplementation.runId, "run-2");

const candidate = recordLedgerCandidate(started.item, {
	runId: "run-1",
	branch: "app-harness-os/1/g1",
	headSha: "2".repeat(40),
	pullRequestNumber: 1,
	pullRequestUrl: "https://github.com/callil/autonomous-live-chat/pull/1",
	now: 7,
});
const artifactReuse = startLedgerImplementation(candidate, { runId: "run-3", now: 8 });
assert.equal(artifactReuse.disposition, "artifact-exists", "a persisted candidate must be reused instead of rebuilt");

assert.throws(() => recordLedgerPlan(started.item, {
	plan: planned.plan,
	now: 7,
}), /Only classified work/, "an active implementation must not be replanned out from under a running inner agent");

const validating = recordLedgerExternalState(candidate, {
	phase: "validating",
	now: 8,
});
assert.throws(() => recordLedgerExternalState(validating, {
	phase: "completed",
	now: 9,
}), /Only a deployed candidate can complete/, "completion cannot skip immutable candidate validation and deployment");

// ---- deployed truth guard: promotion lane OR auto-merge lane, never neither ----
const DEPLOY_URL = "https://autonomous-live-chat.example.workers.dev/";
const MERGED_EVIDENCE = { number: 1, url: "https://github.com/callil/autonomous-live-chat/pull/1", headSha: "2".repeat(40), mergeCommitSha: "3".repeat(40), branch: "app-harness-os/1/g1" };
const MAIN_DEPLOY_SUCCESS = { runId: 77, url: "https://github.com/callil/autonomous-live-chat/actions/runs/77", conclusion: "success" };
assert.throws(() => recordLedgerExternalState(validating, {
	phase: "deployed",
	artifacts: { deploymentUrl: DEPLOY_URL },
	now: 9,
}), /promotion evidence in artifacts\.promotion, or merged plus main-deploy evidence/u, "no evidence, no deployed");
assert.throws(() => recordLedgerExternalState(validating, {
	phase: "deployed",
	artifacts: { deploymentUrl: DEPLOY_URL, merged: MERGED_EVIDENCE },
	now: 9,
}), /promotion evidence in artifacts\.promotion, or merged plus main-deploy evidence/u, "a merge alone is intent, not deployment");
assert.throws(() => recordLedgerExternalState(validating, {
	phase: "deployed",
	artifacts: { deploymentUrl: DEPLOY_URL, merged: MERGED_EVIDENCE, mainDeploy: { ...MAIN_DEPLOY_SUCCESS, conclusion: "failure" } },
	now: 9,
}), /success conclusion/u, "a failed main deploy run can never certify deployed");
assert.throws(() => recordLedgerExternalState(validating, {
	phase: "deployed",
	artifacts: { deploymentUrl: DEPLOY_URL, mainDeploy: MAIN_DEPLOY_SUCCESS },
	now: 9,
}), /promotion evidence in artifacts\.promotion, or merged plus main-deploy evidence/u, "a deploy run without the merged fact proves nothing about this candidate");
assert.throws(() => recordLedgerExternalState(validating, {
	phase: "deployed",
	artifacts: { deploymentUrl: DEPLOY_URL, promotion: { url: "https://github.com/callil/autonomous-live-chat/actions/runs/70", runId: 70 } },
	now: 9,
}), /success conclusion/u, "a promotion dispatch receipt without a success conclusion is still intent");
const autoMergeDeployed = recordLedgerExternalState(validating, {
	phase: "deployed",
	artifacts: { deploymentUrl: DEPLOY_URL, merged: MERGED_EVIDENCE, mainDeploy: MAIN_DEPLOY_SUCCESS },
	now: 9,
});
assert.equal(autoMergeDeployed.phase, "deployed", "merged evidence plus a successful main deploy run is a legal fast-lane deployment");
const autoMergeCompleted = recordLedgerExternalState(autoMergeDeployed, { phase: "completed", now: 10 });
assert.equal(autoMergeCompleted.phase, "completed", "the fast lane completes through deployed like every other item");
const promotionDeployed = recordLedgerExternalState(validating, {
	phase: "deployed",
	artifacts: { deploymentUrl: DEPLOY_URL, promotion: { url: "https://github.com/callil/autonomous-live-chat/actions/runs/70", runId: 70, conclusion: "success" } },
	now: 9,
});
assert.equal(promotionDeployed.phase, "deployed", "the promotion lane remains a legal deployment path");

// ---- promotion lane end to end: promoting, then deployed from the observed
// successful promotion run (webhook-pushed or loop-observed), then completed ----
const VALIDATION_RUN = { runId: 60, url: "https://github.com/callil/autonomous-live-chat/actions/runs/60", conclusion: "success" };
const PROMOTION_RUN = { runId: 70, url: "https://github.com/callil/autonomous-live-chat/actions/runs/70", conclusion: "success", createdAt: "2026-08-06T21:00:00Z", dispatchKey: "dispatch-work-1" };
const promoting = recordLedgerExternalState(validating, { phase: "promoting", artifacts: { validation: VALIDATION_RUN }, now: 9 });
assert.equal(promoting.phase, "promoting", "a validated candidate enters promotion with its validation evidence");
assert.throws(() => recordLedgerExternalState(promoting, {
	phase: "deployed",
	artifacts: { deploymentUrl: DEPLOY_URL },
	now: 10,
}), /success conclusion/u, "phase promoting alone is intent: deployed still requires the promotion run's own success conclusion");
const promotionLaneDeployed = recordLedgerExternalState(promoting, {
	phase: "deployed",
	artifacts: { deploymentUrl: DEPLOY_URL, promotion: PROMOTION_RUN },
	now: 10,
});
assert.equal(promotionLaneDeployed.phase, "deployed", "the successful promotion run fact records deployed from promoting");
assert.deepEqual(promotionLaneDeployed.artifacts.promotion, PROMOTION_RUN, "the promotion evidence — including its durable dispatch key — persists on the item");
const promotionLaneCompleted = recordLedgerExternalState(promotionLaneDeployed, { phase: "completed", now: 11 });
assert.equal(promotionLaneCompleted.phase, "completed", "the promotion lane completes through deployed like every other item");
assert.equal(recordLedgerExternalState(promoting, { phase: "retryable", now: 10 }).phase, "retryable", "a failed promotion run can still clear the item to retryable for a restack");

// A candidate whose validation failed remains replannable: the restack path
// stays open without any lease or claim ceremony.
const restacked = recordLedgerPlan(validating, {
	plan: { ...planned.plan, revision: 2, generation: 2, branch: "app-harness-os/1/g2" },
	now: 10,
});
assert.equal(restacked.phase, "delegated");
assert.equal(restacked.artifacts.candidate, undefined, "a restack clears the stale candidate lineage");

// The failed-run path must never wedge: a failed runner result acknowledged as
// retryable clears the dead generation's activeImplementation outright, and
// the very next legal step is a revised plan for the next generation.
const failedRun = startLedgerImplementation(planned, { runId: "run-9", now: 11 });
assert.equal(failedRun.item.activeImplementation?.runId, "run-9");
const retryable = recordLedgerExternalState(failedRun.item, { phase: "retryable", now: 12 });
assert.equal(retryable.phase, "retryable");
assert.equal(retryable.activeImplementation, null, "retryable clears the failed generation's active implementation");
const replanned = recordLedgerPlan(retryable, {
	plan: { ...planned.plan, revision: 2, generation: 2, branch: "app-harness-os/1/g2" },
	now: 13,
});
assert.equal(replanned.phase, "delegated", "a retryable item restacks directly into a new delegated plan");
assert.equal(replanned.plan.generation, 2);

// ---- multi-node contracts: a dependent node stacks on a pinned sibling ----
// The one-node-only guard is gone; what replaces it is exact: a sibling
// canonical parent branch, the parent's immutable head, the pull request
// based on the parent, and the node's own canonical branch.
const PARENT_HEAD = "4".repeat(40);
const siblingPlan = {
	revision: 1,
	baseSha: SHA,
	stackId: "stack-room-epoch",
	generation: 1,
	nodeId: "n-work0001",
	branch: "app-harness-os/1/g1",
	parentBranch: "app-harness-os/9/g2",
	parentBaseSha: PARENT_HEAD,
	pullRequestBase: "app-harness-os/9/g2",
	issueNumber: 1,
	summary: "Second node",
	ciProfile: "content",
};
const siblingPlanned = recordLedgerPlan(classifiedWithIssue, { plan: siblingPlan, now: 4 });
assert.equal(siblingPlanned.phase, "delegated", "a sibling-parent stack node is a legal plan");
assert.deepEqual(siblingPlanned.plan, siblingPlan, "the dependent node's stack identity persists exactly as staged");
assert.throws(() => recordLedgerPlan(classifiedWithIssue, {
	plan: { ...siblingPlan, parentBranch: "feature/x", pullRequestBase: "feature/x" },
	now: 4,
}), /sibling app-harness-os stack branch/u, "a dependent node's parent must be a canonical sibling stack branch, never arbitrary");
assert.throws(() => recordLedgerPlan(classifiedWithIssue, {
	plan: { ...siblingPlan, parentBaseSha: null },
	now: 4,
}), /parent's immutable head SHA/u, "a dependent node without its parent's pinned head is refused");
assert.throws(() => recordLedgerPlan(classifiedWithIssue, {
	plan: { ...siblingPlan, pullRequestBase: "main" },
	now: 4,
}), /pull request base must be the stack parent branch/u, "a dependent node's pull request targets its parent branch");
assert.throws(() => recordLedgerPlan(classifiedWithIssue, {
	plan: { ...siblingPlan, branch: "app-harness-os/1/g9" },
	now: 4,
}), /must be exactly app-harness-os\/1\/g1/u, "a dependent node's own branch stays canonical per issue and generation");

console.log("ledger contract: ok");
