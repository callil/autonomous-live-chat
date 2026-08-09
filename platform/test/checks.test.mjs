import assert from "node:assert/strict";
import test from "node:test";
import { classifyCheckRuns, includesMigrationMarker } from "../contracts/checks.js";

test("green requires at least one check and every check passing", () => {
	assert.deepEqual(classifyCheckRuns([]), { verdict: "pending" }, "zero checks is never green: unverified code must not merge");
	assert.deepEqual(classifyCheckRuns([
		{ name: "verify", status: "completed", conclusion: "success" },
		{ name: "firewall", status: "completed", conclusion: "skipped" },
		{ name: "lint", status: "completed", conclusion: "neutral" },
	]), { verdict: "green" });
});

test("any failing conclusion is red, with the failed names for the park-and-explain note", () => {
	const verdict = classifyCheckRuns([
		{ name: "verify", status: "completed", conclusion: "failure" },
		{ name: "firewall", status: "completed", conclusion: "success" },
		{ name: "smoke", status: "completed", conclusion: "timed_out" },
	]);
	assert.equal(verdict.verdict, "red");
	assert.deepEqual(verdict.failed, ["verify", "smoke"]);
});

test("in-progress or malformed checks stay pending, never green", () => {
	assert.deepEqual(classifyCheckRuns([
		{ name: "verify", status: "in_progress", conclusion: null },
		{ name: "firewall", status: "completed", conclusion: "success" },
	]), { verdict: "pending" });
	assert.deepEqual(classifyCheckRuns([{ nonsense: true }]), { verdict: "pending" }, "a shape GitHub never documented cannot certify anything");
	assert.throws(() => classifyCheckRuns("not-an-array"), /array/u);
});

test("red outranks pending: a failed check fails fast even while others run", () => {
	const verdict = classifyCheckRuns([
		{ name: "verify", status: "completed", conclusion: "failure" },
		{ name: "slow-suite", status: "in_progress", conclusion: null },
	]);
	assert.equal(verdict.verdict, "red");
});

test("the migration marker is derived from actual changed paths", () => {
	assert.equal(includesMigrationMarker(["apps/demo/src/index.ts", "packages/react/overlay.tsx"]), false);
	assert.equal(includesMigrationMarker(["apps/demo/migrations/0002-add-column.sql"]), true);
	assert.equal(includesMigrationMarker(["apps/demo/src/user-migration-plan.ts"]), true);
	assert.equal(includesMigrationMarker([]), false);
	assert.throws(() => includesMigrationMarker("nope"), /array/u);
});
