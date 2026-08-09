import assert from "node:assert/strict";
import test from "node:test";
import { classifyRunTier, SMALL_MAX_TEXT_CHARS, TIER_BUDGETS, tierBudgets } from "../contracts/tier.js";

test("a short single-anchor style tweak classifies small", () => {
	for (const text of ["darken the header", "make this button blue", "Change the copy to “Get started”.", "increase the padding a bit"]) {
		assert.equal(classifyRunTier({ kind: "target", text, annotationCount: 1 }), "small", text);
	}
});

test("breadth markers defeat smallness however short the sentence", () => {
	for (const text of ["darken all headers", "make every button blue", "refactor this", "rename it throughout", "redesign the page"]) {
		assert.equal(classifyRunTier({ kind: "target", text, annotationCount: 1 }), "normal", text);
	}
});

test("multi-part requests are never small", () => {
	for (const text of ["darken the header and also widen it", "make it blue, then add a border", "fix this; also fix the footer"]) {
		assert.equal(classifyRunTier({ kind: "target", text, annotationCount: 1 }), "normal", text);
	}
});

test("more than one anchor is never small", () => {
	assert.equal(classifyRunTier({ kind: "target", text: "darken these", annotationCount: 2 }), "normal");
});

test("long text is never small", () => {
	assert.equal(classifyRunTier({ kind: "target", text: "x".repeat(SMALL_MAX_TEXT_CHARS + 1), annotationCount: 1 }), "normal");
});

test("a textless draw takes the normal budget", () => {
	assert.equal(classifyRunTier({ kind: "draw", text: "", annotationCount: 1 }), "normal");
	assert.equal(classifyRunTier({ kind: "draw", text: "   ", annotationCount: 1 }), "normal");
});

test("unknown shapes fall back to normal, the safe direction", () => {
	assert.equal(classifyRunTier({ kind: "chat", text: "hi", annotationCount: 1 }), "normal");
	assert.equal(classifyRunTier({ kind: "target", text: "hi", annotationCount: 0 }), "normal");
	assert.equal(classifyRunTier({ kind: "target", text: null, annotationCount: 1 }), "normal");
	assert.equal(classifyRunTier({ kind: "target", text: "hi", annotationCount: "1" }), "normal");
});

test("small budgets are strictly cheaper than normal, and normal is unchanged", () => {
	assert.equal(TIER_BUDGETS.normal.effort, "medium", "normal must reproduce today's behaviour");
	assert.equal(TIER_BUDGETS.normal.maxToolCalls, 12);
	assert.equal(TIER_BUDGETS.normal.includeTree, true);
	assert.equal(TIER_BUDGETS.small.effort, "low");
	assert.ok(TIER_BUDGETS.small.maxToolCalls < TIER_BUDGETS.normal.maxToolCalls);
	assert.equal(TIER_BUDGETS.small.includeTree, false);
});

test("tierBudgets falls back to normal for anything unrecognised", () => {
	assert.deepEqual(tierBudgets("nonsense"), TIER_BUDGETS.normal);
	assert.deepEqual(tierBudgets(undefined), TIER_BUDGETS.normal);
	assert.deepEqual(tierBudgets("small"), TIER_BUDGETS.small);
});
