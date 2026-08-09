import assert from "node:assert/strict";
import test from "node:test";
import {
	amendIntent,
	amendmentDisposition,
	countOpenIntents,
	createIntent,
	dispatchIntent,
	OPEN_INTENT_LIMIT,
	recordIntentOutcome,
	underOpenIntentLimit,
	withdrawIntent,
} from "../contracts/intent.js";

const base = createIntent({ id: "intent-1", openedBy: "callil", at: 10, refs: { utteranceSeqs: [3], annotationSeqs: [4] }, openSeq: 5 });

test("an intent is a versioned pointer into the ledger", () => {
	assert.equal(base.state, "open");
	assert.equal(base.version, 1);
	assert.deepEqual(base.refs, { utteranceSeqs: [3], annotationSeqs: [4] });
	assert.equal(base.openSeq, 5, "the intent-opened seq names the run branch room/<openSeq>/<attempt>");
	assert.throws(() => createIntent({ id: "intent-x", openedBy: "callil", at: 10, refs: { utteranceSeqs: [0], annotationSeqs: [] }, openSeq: 5 }), /positive ledger sequences/u);
	assert.throws(() => createIntent({ id: "intent-x", openedBy: "callil", at: 10, refs: { utteranceSeqs: [], annotationSeqs: [] } }), /openSeq/u, "an intent without its ledger ordinal is a caller bug");
});

test("amendments while open bump the version and append pointers", () => {
	const amended = amendIntent(base, { refs: { utteranceSeqs: [7], annotationSeqs: [] }, at: 12 });
	assert.equal(amended.version, 2);
	assert.deepEqual(amended.refs.utteranceSeqs, [3, 7], "existing pointers are never replaced");
	assert.equal(amendmentDisposition(amended), "amend");
});

test("amendments while running become follow-up intents (v1 ruling: no steer files)", () => {
	const dispatched = dispatchIntent(base, { runId: "run-1", at: 15 });
	assert.equal(dispatched.state, "dispatched");
	assert.equal(dispatched.version, 2);
	assert.equal(amendmentDisposition(dispatched), "follow-up");
	assert.throws(() => amendIntent(dispatched, { refs: { utteranceSeqs: [9], annotationSeqs: [] }, at: 16 }), /follow-up/u);
	const live = recordIntentOutcome(dispatched, { state: "live", at: 20 });
	assert.equal(amendmentDisposition(live), "follow-up");
});

test("lifecycle guards: open -> dispatched -> live|parked; open -> withdrawn", () => {
	const dispatched = dispatchIntent(base, { runId: "run-1", at: 15 });
	assert.throws(() => dispatchIntent(dispatched, { runId: "run-2", at: 16 }), /not open/u);
	const parked = recordIntentOutcome(dispatched, { state: "parked", at: 17, detail: "run-ttl-exceeded" });
	assert.equal(parked.state, "parked");
	assert.throws(() => recordIntentOutcome(parked, { state: "live", at: 18 }), /not dispatched/u);
	const withdrawn = withdrawIntent(base, { at: 11 });
	assert.equal(withdrawn.state, "withdrawn");
	assert.throws(() => withdrawIntent(dispatched, { at: 16 }), /only open intents withdraw/u);
});

test("per-user open-intent rate limit counts open and dispatched, not terminal", () => {
	const intents = [
		base,
		dispatchIntent(createIntent({ id: "intent-2", openedBy: "callil", at: 1, refs: { utteranceSeqs: [], annotationSeqs: [1] }, openSeq: 6 }), { runId: "run-9", at: 2 }),
		recordIntentOutcome(dispatchIntent(createIntent({ id: "intent-3", openedBy: "callil", at: 1, refs: { utteranceSeqs: [], annotationSeqs: [2] }, openSeq: 7 }), { runId: "run-8", at: 2 }), { state: "live", at: 3 }),
		createIntent({ id: "intent-4", openedBy: "guest", at: 1, refs: { utteranceSeqs: [], annotationSeqs: [3] }, openSeq: 8 }),
	];
	assert.equal(countOpenIntents(intents, "callil"), 2);
	assert.equal(countOpenIntents(intents, "guest"), 1);
	assert.equal(OPEN_INTENT_LIMIT, 5);
	assert.ok(underOpenIntentLimit(intents, "callil"));
	assert.ok(!underOpenIntentLimit(intents, "callil", 2), "the cap refuses the sixth open intent at the default limit");
});
