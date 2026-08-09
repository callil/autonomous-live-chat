import assert from "node:assert/strict";
import test from "node:test";
import { CANCEL_WINDOW_MS, cancelDeadline, mayDispatch, parseRequestEnvelope, REQUEST_ENVELOPE_TYPES } from "../contracts/envelope.js";

const anchor = { dataLoc: "app/header:3:1", domSnapshot: "<header data-loc=\"app/header:3:1\">Live</header>" };

test("the explicit envelope is the sole request trigger: plain chat is chat", () => {
	assert.equal(parseRequestEnvelope({ type: "chat:send", text: "please make the header darker" }), null, "chat is never classified into a change request");
	assert.equal(parseRequestEnvelope({ type: "feed:history" }), null);
	assert.equal(parseRequestEnvelope(null), null);
	assert.deepEqual(REQUEST_ENVELOPE_TYPES, ["request:target", "request:comment", "request:draw"]);
});

test("a target envelope requires text and a verbatim anchor", () => {
	const envelope = parseRequestEnvelope({ type: "request:target", text: "darken this", annotation: { ...anchor, computedStyles: { color: "#fff" } } });
	assert.equal(envelope.kind, "target");
	assert.equal(envelope.text, "darken this");
	assert.equal(envelope.annotation.computedStyles.color, "#fff", "captured evidence rides through verbatim");
	assert.throws(() => parseRequestEnvelope({ type: "request:target", annotation: anchor }), /request text/u);
	assert.throws(() => parseRequestEnvelope({ type: "request:target", text: "x", annotation: { domSnapshot: "<a/>" } }), /data-loc/u);
	assert.throws(() => parseRequestEnvelope({ type: "request:target", text: "x", annotation: { dataLoc: "x" } }), /DOM snapshot/u);
});

test("comment and draw envelopes carry their own evidence requirements", () => {
	const comment = parseRequestEnvelope({ type: "request:comment", annotation: { ...anchor, text: "too dark here" } });
	assert.equal(comment.text, "too dark here", "a comment's text is the annotation text");
	assert.throws(() => parseRequestEnvelope({ type: "request:comment", annotation: anchor }), /text/u);
	const draw = parseRequestEnvelope({ type: "request:draw", annotation: { ...anchor, drawingPoints: [{ x: 1, y: 2 }] } });
	assert.deepEqual(draw.annotation.drawingPoints, [{ x: 1, y: 2 }]);
	assert.throws(() => parseRequestEnvelope({ type: "request:draw", annotation: anchor }), /drawing points/u);
});

test("the envelope kind comes from the message type, never from the payload", () => {
	const envelope = parseRequestEnvelope({ type: "request:target", text: "x", annotation: { ...anchor, kind: "draw" } });
	assert.equal(envelope.annotation.kind, "target", "a payload cannot smuggle a different kind past validation");
});

test("every accepted request holds for a 10-second cancel window before dispatch", () => {
	assert.equal(CANCEL_WINDOW_MS, 10_000);
	assert.equal(cancelDeadline(1_000), 11_000);
	assert.ok(!mayDispatch(1_000, 10_999));
	assert.ok(mayDispatch(1_000, 11_000));
});
