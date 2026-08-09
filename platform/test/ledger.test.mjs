import assert from "node:assert/strict";
import test from "node:test";
import {
	assertAppendable,
	createLedgerEvent,
	eventStorageKey,
	isLedgerEventKind,
	LEDGER_EVENT_KINDS,
	validateAnnotationPayload,
} from "../contracts/ledger.js";

test("the event kind vocabulary is closed and validated", () => {
	assert.ok(LEDGER_EVENT_KINDS.includes("annotation"));
	assert.ok(!isLedgerEventKind("model-opinion"), "no free-form kinds enter the ledger");
	assert.throws(() => createLedgerEvent({ seq: 1, kind: "model-opinion", at: 1, payload: {} }), /Unknown ledger event kind/u);
});

test("append-only discipline: sequences are strictly monotonic with no holes", () => {
	const event = createLedgerEvent({ seq: 2, kind: "utterance", at: 5, payload: { author: "callil", text: "hello" } });
	assert.equal(assertAppendable(1, event), event);
	assert.throws(() => assertAppendable(2, event), /out of order/u, "a repeated sequence is loud");
	assert.throws(() => assertAppendable(0, event), /out of order/u, "a skipped sequence is loud");
	assert.throws(() => createLedgerEvent({ seq: 0, kind: "utterance", at: 5, payload: { author: "callil", text: "x" } }), /positive integer sequence/u);
});

test("events are frozen facts", () => {
	const event = createLedgerEvent({ seq: 1, kind: "utterance", at: 1, payload: { author: "callil", text: "hi" } });
	assert.ok(Object.isFrozen(event));
	assert.throws(() => { event.kind = "annotation"; }, TypeError, "a recorded fact cannot be rewritten");
});

test("annotation payloads are stored VERBATIM: validation never strips or rewrites fields", () => {
	const payload = {
		kind: "target",
		dataLoc: "app/header:3:1",
		domSnapshot: "<header data-loc=\"app/header:3:1\">Live</header>",
		selector: "header > h1",
		computedStyles: { color: "rgb(0, 0, 0)" },
		screenshotCrop: "data:image/png;base64,AAAA",
		anUnknownFutureField: { nested: [1, 2, 3] },
	};
	const validated = validateAnnotationPayload(payload);
	assert.equal(validated, payload, "the same object rides through by reference — nothing is summarized away");
	const event = createLedgerEvent({ seq: 1, kind: "annotation", at: 1, payload: { by: "callil", annotation: payload } });
	assert.deepEqual(event.payload.annotation, payload);
});

test("annotation anchors are required per kind", () => {
	assert.throws(() => validateAnnotationPayload({ kind: "target", domSnapshot: "<a/>" }), /data-loc/u);
	assert.throws(() => validateAnnotationPayload({ kind: "target", dataLoc: "x" }), /DOM snapshot/u);
	assert.throws(() => validateAnnotationPayload({ kind: "draw", dataLoc: "x", domSnapshot: "<a/>" }), /drawing points/u);
	assert.throws(() => validateAnnotationPayload({ kind: "comment", dataLoc: "x", domSnapshot: "<a/>" }), /text/u);
	assert.throws(() => validateAnnotationPayload({ kind: "vibe", dataLoc: "x", domSnapshot: "<a/>" }), /target, comment, or draw/u);
	assert.ok(validateAnnotationPayload({ kind: "draw", dataLoc: "x", domSnapshot: "<a/>", drawingPoints: [{ x: 1, y: 2 }] }));
	assert.ok(validateAnnotationPayload({ kind: "comment", dataLoc: "x", domSnapshot: "<a/>", text: "make it pop" }));
});

test("utterance and revert payloads are validated", () => {
	assert.throws(() => createLedgerEvent({ seq: 1, kind: "utterance", at: 1, payload: { author: "callil", text: "" } }), /non-empty/u);
	assert.throws(() => createLedgerEvent({ seq: 1, kind: "revert-requested", at: 1, payload: { sha: "abc" } }), /full Git SHA/u);
	assert.ok(createLedgerEvent({ seq: 1, kind: "revert-requested", at: 1, payload: { sha: "a".repeat(40), by: "owner" } }));
});

test("storage keys sort lexicographically in sequence order", () => {
	assert.equal(eventStorageKey(7), "event:000000000007");
	assert.ok(eventStorageKey(9) < eventStorageKey(10), "padding keeps list order equal to sequence order");
	assert.ok(eventStorageKey(999999999999) > eventStorageKey(2));
});
