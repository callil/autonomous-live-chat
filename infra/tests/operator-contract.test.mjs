import assert from "node:assert/strict";
import { assertOperatorCommandAllowed, operatorActionEffectKey, operatorCommandEffectSatisfied } from "../../packages/contracts/operator.js";

const claimed = {
	id: "work-1",
	phase: "claimed",
	lease: { id: "lease-1", operatorId: "cloudflare-os", expiresAt: 10_000 },
	classification: null,
	plan: null,
	activeImplementation: null,
	artifacts: {},
};

assert.doesNotThrow(() => assertOperatorCommandAllowed(claimed, { kind: "classify" }, 1));
assert.throws(() => assertOperatorCommandAllowed(claimed, { kind: "create-issue" }, 1), /eligible classification/u, "an issue cannot skip classification");
assert.throws(() => assertOperatorCommandAllowed(claimed, { kind: "plan", plan: { revision: 1 } }, 1), /existing GitHub issue/u, "a plan cannot skip issue projection");
assert.throws(() => assertOperatorCommandAllowed(claimed, { kind: "claim", leaseId: "lease-2" }, 1), /live operator lease/u, "a model cannot churn claim revisions while its lease is live");

const classified = { ...claimed, phase: "classified", classification: { decision: "eligible" } };
assert.doesNotThrow(() => assertOperatorCommandAllowed(classified, { kind: "create-issue" }, 1));
const withIssue = { ...classified, artifacts: { issue: { number: 1, url: "https://github.com/callil/autonomous-live-chat/issues/1" } } };
assert.throws(() => assertOperatorCommandAllowed(withIssue, { kind: "create-issue" }, 1), /no existing issue/u, "the same work item cannot create a second issue");
assert.doesNotThrow(() => assertOperatorCommandAllowed(withIssue, { kind: "plan", plan: { revision: 1 } }, 1));
assert.doesNotThrow(() => assertOperatorCommandAllowed({ ...claimed, artifacts: withIssue.artifacts }, { kind: "classify" }, 1), "a previously created issue can be reconciled by the still-missing classification");

assert.equal(operatorActionEffectKey("work-1", { kind: "create-issue" }), "work-1:issue");
assert.equal(operatorActionEffectKey("work-1", { kind: "create-issue" }), operatorActionEffectKey("work-1", { kind: "create-issue" }), "issue identity is revision-independent");
assert.notEqual(operatorActionEffectKey("work-1", { kind: "plan", plan: { revision: 1 } }), operatorActionEffectKey("work-1", { kind: "plan", plan: { revision: 2 } }), "deliberate plan revisions remain distinct effects");
assert.equal(operatorCommandEffectSatisfied(withIssue, { kind: "create-issue" }), true, "an interrupted issue action reconciles from its durable artifact");
assert.equal(operatorCommandEffectSatisfied({ ...withIssue, plan: { revision: 1 } }, { kind: "plan", plan: { revision: 1 } }), true, "an interrupted plan action reconciles from the exact durable revision");
assert.equal(operatorCommandEffectSatisfied(withIssue, { kind: "promote", dispatchKey: "dispatch-1" }), false, "an external dispatch is never guessed from ledger phase alone");
assert.equal(operatorCommandEffectSatisfied({ ...withIssue, phase: "retryable" }, { kind: "record-state", phase: "retryable" }), true, "a lost receipt for an exact retryable transition reconciles without blocking the next claim");

console.log("operator action ordering and semantic idempotency contracts passed");
