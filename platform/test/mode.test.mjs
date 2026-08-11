import assert from "node:assert/strict";
import test from "node:test";
import { MODE_BUDGETS, modeBudgets, normalizeRunMode, RUN_MODES } from "../contracts/mode.js";
import { parseRequestEnvelope } from "../contracts/envelope.js";

// The automatic small/normal tier classifier is gone by owner decision:
// measured runs showed low effort did not reduce wall clock, so silent
// downgrades traded quality for nothing. Fast is now a USER choice only.

const annotation = {
	kind: "target",
	dataLoc: "product/src/ui/room.html:41",
	domSnapshot: "<h1>Live room</h1>",
};

test("the mode vocabulary is exactly standard and fast", () => {
	assert.deepEqual([...RUN_MODES], ["standard", "fast"]);
});

test("only a literal fast is fast; everything else is standard", () => {
	assert.equal(normalizeRunMode("fast"), "fast");
	for (const value of ["standard", "small", "normal", "FAST", "", null, undefined, 1, {}, true]) {
		assert.equal(normalizeRunMode(value), "standard", String(value));
	}
});

test("the request envelope carries the requester's explicit mode", () => {
	const fast = parseRequestEnvelope({ type: "request:target", text: "darken the header", annotation, mode: "fast" });
	assert.equal(fast.mode, "fast");
});

test("an envelope without a mode is standard: the system never downgrades on its own", () => {
	const plain = parseRequestEnvelope({ type: "request:target", text: "darken the header", annotation });
	assert.equal(plain.mode, "standard");
	const junk = parseRequestEnvelope({ type: "request:target", text: "darken the header", annotation, mode: "cheap" });
	assert.equal(junk.mode, "standard");
});

test("standard is the system's best: full effort, full ceiling, tree, iterating self-review", () => {
	assert.equal(MODE_BUDGETS.standard.effort, "medium");
	assert.equal(MODE_BUDGETS.standard.maxToolCalls, 12);
	assert.equal(MODE_BUDGETS.standard.includeTree, true);
	assert.equal(MODE_BUDGETS.standard.selfReview, "iterate");
});

test("fast budgets are strictly tighter, and the self-review stays a CHECK, never skipped", () => {
	assert.equal(MODE_BUDGETS.fast.effort, "low");
	assert.ok(MODE_BUDGETS.fast.maxToolCalls < MODE_BUDGETS.standard.maxToolCalls);
	assert.equal(MODE_BUDGETS.fast.includeTree, false);
	assert.equal(MODE_BUDGETS.fast.selfReview, "check");
});

test("modeBudgets falls back to the standard (full-quality) budget for anything unrecognised", () => {
	assert.deepEqual(modeBudgets("nonsense"), MODE_BUDGETS.standard);
	assert.deepEqual(modeBudgets(undefined), MODE_BUDGETS.standard);
	assert.deepEqual(modeBudgets("fast"), MODE_BUDGETS.fast);
});
