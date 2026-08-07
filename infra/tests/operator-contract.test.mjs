import assert from "node:assert/strict";
import { assertOperatorCommandAllowed, operatorActionEffectKey, operatorCommandEffectSatisfied } from "../../packages/contracts/operator.js";
import { SYSTEM_PROMPT, TOOLS } from "../workers/operator/src/operator-tools.js";

const toolNames = new Set(TOOLS.map((entry) => entry.function.name));
for (const method of ["getMainSha", "inspectImplementation", "getCandidate", "observeCandidateValidation", "findPromotionRun", "inspectPromotionRun"]) {
	assert.ok(toolNames.has(method), `the operator worker keeps required observation ${method}`);
}
for (const retired of ["stageClaim", "stageRelease", "stageDefer"]) {
	assert.ok(!toolNames.has(retired), `${retired} died with the lease machinery`);
}
assert.match(SYSTEM_PROMPT, /classification -> issue -> plan -> implementation -> candidate -> validating -> promotion -> deployed -> completed/u, "the compact prompt encodes legal workflow order");
assert.doesNotMatch(SYSTEM_PROMPT, /claim|lease|defer/iu, "no lease vocabulary survives in the prompt");
assert.match(SYSTEM_PROMPT, /reply WAITING/u, "waiting is a turn outcome, not a ledger command");

const submitted = {
	id: "work-1",
	phase: "submitted",
	classification: null,
	plan: null,
	activeImplementation: null,
	artifacts: {},
};

assert.doesNotThrow(() => assertOperatorCommandAllowed(submitted, { kind: "classify" }), "classification is legal straight from submitted, no claim required");
assert.throws(() => assertOperatorCommandAllowed(submitted, { kind: "create-issue" }), /eligible classification/u, "an issue cannot skip classification");
assert.throws(() => assertOperatorCommandAllowed(submitted, { kind: "plan", plan: { revision: 1 } }), /existing GitHub issue/u, "a plan cannot skip issue projection");
assert.throws(() => assertOperatorCommandAllowed(submitted, { kind: "claim", leaseId: "lease-2" }), /Unknown operator command/u, "claim is no longer a command at all");
assert.throws(() => assertOperatorCommandAllowed(submitted, { kind: "release", leaseId: "lease-1" }), /Unknown operator command/u);
assert.throws(() => assertOperatorCommandAllowed(submitted, { kind: "defer", leaseId: "lease-1", delayMs: 1_000 }), /Unknown operator command/u);

const classified = { ...submitted, phase: "classified", classification: { decision: "eligible" } };
assert.doesNotThrow(() => assertOperatorCommandAllowed(classified, { kind: "create-issue" }));
const withIssue = { ...classified, artifacts: { issue: { number: 1, url: "https://github.com/callil/autonomous-live-chat/issues/1" } } };
assert.throws(() => assertOperatorCommandAllowed(withIssue, { kind: "create-issue" }), /no existing issue/u, "the same work item cannot create a second issue");
assert.doesNotThrow(() => assertOperatorCommandAllowed(withIssue, { kind: "plan", plan: { revision: 1 } }));
assert.doesNotThrow(() => assertOperatorCommandAllowed({ ...submitted, artifacts: withIssue.artifacts }, { kind: "classify" }), "a previously created issue can be reconciled by the still-missing classification");

assert.equal(operatorActionEffectKey("work-1", { kind: "create-issue" }), "work-1:issue");
assert.equal(operatorActionEffectKey("work-1", { kind: "create-issue" }), operatorActionEffectKey("work-1", { kind: "create-issue" }), "issue identity is revision-independent");
assert.notEqual(operatorActionEffectKey("work-1", { kind: "plan", plan: { revision: 1 } }), operatorActionEffectKey("work-1", { kind: "plan", plan: { revision: 2 } }), "deliberate plan revisions remain distinct effects");
assert.throws(() => operatorActionEffectKey("work-1", { kind: "defer", leaseId: "x", delayMs: 5 }), /Unknown operator command/u, "retired commands have no effect identity");
assert.equal(operatorCommandEffectSatisfied(withIssue, { kind: "create-issue" }), true, "an interrupted issue action reconciles from its durable artifact");
assert.equal(operatorCommandEffectSatisfied({ ...withIssue, plan: { revision: 1 } }, { kind: "plan", plan: { revision: 1 } }), true, "an interrupted plan action reconciles from the exact durable revision");
assert.equal(operatorCommandEffectSatisfied(withIssue, { kind: "promote", dispatchKey: "dispatch-1" }), false, "an external dispatch is never guessed from ledger phase alone");
assert.equal(operatorCommandEffectSatisfied({ ...withIssue, phase: "retryable" }, { kind: "record-state", phase: "retryable" }), true, "a lost receipt for an exact retryable transition reconciles without blocking the next turn");

console.log("operator action ordering and semantic idempotency contracts passed");
