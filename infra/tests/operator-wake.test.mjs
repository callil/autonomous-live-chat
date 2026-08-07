import assert from "node:assert/strict";
import { beginOperatorWakeDelivery, queueOperatorWakeRecord, settleOperatorWakeRecord } from "../../packages/contracts/wake.js";

const pending = queueOperatorWakeRecord(undefined, { id: "work-1", workItemId: "work-1", version: 1, now: 100, delayMs: 0 });
const inFlight = beginOperatorWakeDelivery(pending, { currentVersion: 1, terminal: false, now: 100, responseLeaseMs: 1_000 });
assert.equal(inFlight.state, "in_flight");
assert.equal(inFlight.attempts, 1, "the initial delivery counts toward the bounded recovery budget");

const advancedDuringTurn = queueOperatorWakeRecord(inFlight, { id: "work-1", workItemId: "work-1", version: 2, now: 110, delayMs: 0 });
assert.equal(advancedDuringTurn.version, 1, "a ledger mutation cannot replace the active Cloudflare OS turn");
assert.equal(advancedDuringTurn.nextVersion, 2, "the latest revision is remembered behind the active turn barrier");
assert.equal(advancedDuringTurn.availableAt, 1_100, "mutations cannot shorten the active response lease");

const afterResponse = settleOperatorWakeRecord(advancedDuringTurn, { currentVersion: 2, expectedVersion: 1, turn: 1, terminal: false, now: 120 });
assert.deepEqual(afterResponse, { id: "work-1", workItemId: "work-1", version: 2, turn: 2, state: "pending", attempts: 0, availableAt: 120 }, "the completed response releases exactly the latest revision");

assert.equal(settleOperatorWakeRecord(inFlight, { currentVersion: 1, expectedVersion: 1, turn: 1, terminal: false, now: 120 }), null, "a no-progress turn parks instead of recursively prompting itself");
assert.equal(settleOperatorWakeRecord(inFlight, { currentVersion: 2, expectedVersion: 1, turn: 2, terminal: false, now: 120 }), undefined, "a mismatched callback cannot release another turn");

const recovered = beginOperatorWakeDelivery(advancedDuringTurn, { currentVersion: 2, terminal: false, now: 1_100, responseLeaseMs: 1_000 });
assert.equal(recovered.version, 2);
assert.equal(recovered.turn, 2);
assert.equal(recovered.state, "in_flight");
assert.equal(recovered.attempts, 2, "a missing callback produces one explicit recovery attempt after the full response lease");
assert.equal(beginOperatorWakeDelivery(afterResponse, { currentVersion: 2, terminal: true, now: 130, responseLeaseMs: 1_000 }), null, "terminal work deletes pending wakes");

console.log("operator wake barrier and no-progress contracts passed");
