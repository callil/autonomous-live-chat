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
const duplicate = startLedgerImplementation(started.item, { runId: "run-2", now: 6 });
assert.equal(duplicate.disposition, "resume", "the same accepted plan must resume instead of spawning duplicate coding-agent work");

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

// A candidate whose validation failed remains replannable: the restack path
// stays open without any lease or claim ceremony.
const restacked = recordLedgerPlan(validating, {
	plan: { ...planned.plan, revision: 2, generation: 2, branch: "app-harness-os/1/g2" },
	now: 10,
});
assert.equal(restacked.phase, "delegated");
assert.equal(restacked.artifacts.candidate, undefined, "a restack clears the stale candidate lineage");

console.log("ledger contract: ok");
