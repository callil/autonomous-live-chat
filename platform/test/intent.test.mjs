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
	retryIntent,
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

test("the Doctor's retry is exactly once, and only while dispatched", () => {
	let intent = createIntent({ id: "intent-9", openedBy: "Ada", openedById: "user-11111111-1111-1111-1111-111111111111", at: 1, refs: { utteranceSeqs: [], annotationSeqs: [1] }, openSeq: 1 });
	assert.throws(() => retryIntent(intent, { runId: "run-9", at: 2 }), /only a dispatched intent/u);
	intent = dispatchIntent(intent, { runId: "run-1", at: 2 });
	const retried = retryIntent(intent, { runId: "run-2", at: 3 });
	assert.equal(retried.runId, "run-2");
	assert.equal(retried.retried, true);
	assert.equal(retried.state, "dispatched", "the intent stays dispatched through its retry");
	assert.throws(() => retryIntent(retried, { runId: "run-3", at: 4 }), /already used its one retry/u);
});

test("display names with spaces open intents; ids never carry spaces", () => {
	const spaced = createIntent({ id: "intent-12", openedBy: "Phase3 E2E", openedById: "user-33333333-3333-3333-3333-333333333333", at: 1, refs: { utteranceSeqs: [], annotationSeqs: [1] }, openSeq: 3 });
	assert.equal(spaced.openedBy, "Phase3 E2E");
	assert.throws(() => createIntent({ id: "intent-13", openedBy: "Ada", openedById: "user with spaces", at: 1, refs: { utteranceSeqs: [], annotationSeqs: [1] }, openSeq: 4 }), /identifier/u);
	assert.throws(() => createIntent({ id: "intent-14", openedBy: "a\nb", openedById: "user-4", at: 1, refs: { utteranceSeqs: [], annotationSeqs: [1] }, openSeq: 5 }), /display name/u);
});

test("attribution and the open-intent cap key on the stable session id", () => {
	const byId = createIntent({ id: "intent-10", openedBy: "Ada", openedById: "user-22222222-2222-2222-2222-222222222222", at: 1, refs: { utteranceSeqs: [], annotationSeqs: [1] }, openSeq: 2 });
	assert.equal(countOpenIntents([byId], "user-22222222-2222-2222-2222-222222222222"), 1, "the stable id counts");
	assert.equal(countOpenIntents([byId], "Ada"), 0, "the display name does not");
	const legacy = { ...byId, openedById: undefined, id: "intent-11" };
	assert.equal(countOpenIntents([legacy], "Ada"), 1, "pre-identity records fall back to the display name");
});
