import assert from "node:assert/strict";
import {
	claimLedgerWorkItem,
	createLedgerWorkItem,
	deferLedgerWorkItem,
	implementationKey,
	recordLedgerCandidate,
	recordLedgerClassification,
	recordLedgerExternalState,
	recordLedgerPlan,
	startLedgerImplementation,
} from "../../packages/contracts/ledger.js";

const SHA = "1".repeat(40);
const base = createLedgerWorkItem({ id: "work-1", room: "main", request: "Update the heading", now: 1 });
const claimed = claimLedgerWorkItem(base, { operatorId: "cloudflare-os", leaseId: "lease-1", now: 2, leaseMs: 1_000 }).item;
const classified = recordLedgerClassification(claimed, {
	operatorId: "cloudflare-os",
	leaseId: "lease-1",
	classification: { decision: "eligible", changeType: "content", scope: "localized", risk: "low", affectedSurface: "copy", reversible: true, executionEligibility: "eligible", ciProfile: "content" },
	now: 3,
});
const classifiedWithIssue = { ...classified, artifacts: { issue: { number: 1, url: "https://github.com/callil/autonomous-live-chat/issues/1" } } };
const planned = recordLedgerPlan(classifiedWithIssue, {
	operatorId: "cloudflare-os",
	leaseId: "lease-1",
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

const started = startLedgerImplementation(planned, { operatorId: "cloudflare-os", leaseId: "lease-1", runId: "run-1", now: 5 });
assert.equal(started.disposition, "started");
const duplicate = startLedgerImplementation(started.item, { operatorId: "cloudflare-os", leaseId: "lease-1", runId: "run-2", now: 6 });
assert.equal(duplicate.disposition, "resume", "the same accepted plan must resume instead of spawning duplicate NanoCodex work");

const candidate = recordLedgerCandidate(started.item, {
	operatorId: "cloudflare-os",
	leaseId: "lease-1",
	runId: "run-1",
	branch: "app-harness-os/1/g1",
	headSha: "2".repeat(40),
	pullRequestNumber: 1,
	pullRequestUrl: "https://github.com/callil/autonomous-live-chat/pull/1",
	now: 7,
});
const artifactReuse = startLedgerImplementation(candidate, { operatorId: "cloudflare-os", leaseId: "lease-1", runId: "run-3", now: 8 });
assert.equal(artifactReuse.disposition, "artifact-exists", "a persisted candidate must be reused instead of rebuilt");

assert.throws(() => recordLedgerPlan(started.item, {
	operatorId: "cloudflare-os",
	leaseId: "lease-1",
	plan: planned.plan,
	now: 7,
}), /Only classified work/, "an active implementation must not be replanned out from under a running inner agent");

const validating = recordLedgerExternalState(candidate, {
	operatorId: "cloudflare-os",
	leaseId: "lease-1",
	phase: "validating",
	now: 8,
});
assert.throws(() => recordLedgerExternalState(validating, {
	operatorId: "cloudflare-os",
	leaseId: "lease-1",
	phase: "completed",
	now: 9,
}), /Only a deployed candidate can complete/, "completion cannot skip immutable candidate validation and deployment");

const competing = claimLedgerWorkItem(planned, { operatorId: "other", leaseId: "lease-2", now: 5, leaseMs: 1_000 });
assert.equal(competing.disposition, "busy");

const deferred = deferLedgerWorkItem(planned, { operatorId: "cloudflare-os", leaseId: "lease-1", now: 5, delayMs: 100 });
assert.equal(claimLedgerWorkItem(deferred, { operatorId: "cloudflare-os", leaseId: "lease-2", now: 50, leaseMs: 1_000 }).disposition, "deferred");
assert.equal(claimLedgerWorkItem(deferred, { operatorId: "cloudflare-os", leaseId: "lease-2", now: 105, leaseMs: 1_000 }).disposition, "claimed");

console.log("ledger contract: ok");
