import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

async function source(path) {
	return readFile(resolve(root, path), "utf8");
}

function count(text, expression) {
	return [...text.matchAll(expression)].length;
}

const [demo, wrangler, allowlist] = await Promise.all([
	source("apps/demo/src/index.ts"),
	source("apps/demo/wrangler.jsonc"),
	source("infra/tests/control-plane-migration-allowlist.json").then(JSON.parse),
]);

assert.equal(allowlist.version, 1, "the migration allowlist needs an explicit version");
assert.ok(Array.isArray(allowlist.entries), "the migration allowlist needs an entries array");

/**
 * These are architecture boundaries, not code-style preferences. A violation is
 * allowed only while it is explicitly enumerated below, with its exact count.
 * New use cannot hide behind an existing migration entry; it changes the count
 * and fails this test. Once the cutover removes a responsibility, delete its
 * allowlist entry in the same change. An empty allowlist makes every boundary
 * absolute without changing this test.
 */
const observed = [
	{
		id: "demo-legacy-control-plane-imports",
		file: "apps/demo/src/index.ts",
		count: count(demo, /from\s+["'][^"']*infra\/orchestration\/(?:[^"']*(?:coordinator|github|runner)[^"']*|os-provider-bridge)\.js["']/gu),
	},
	{
		id: "demo-direct-github-api",
		file: "apps/demo/src/index.ts",
		count: count(demo, /https:\/\/api\.github\.com/gu),
	},
	{
		id: "demo-actions-dispatch",
		file: "apps/demo/src/index.ts",
		count: count(demo, /actions\/workflows/gu),
	},
	{
		id: "demo-coordinator-job-prefix",
		file: "apps/demo/src/index.ts",
		count: count(demo, /coordinator-job:/gu),
	},
	{
		id: "demo-coordinator-outbox-prefix",
		file: "apps/demo/src/index.ts",
		count: count(demo, /coordinator-outbox:/gu),
	},
	{
		id: "demo-workflow-callback-routes",
		file: "apps/demo/src/index.ts",
		count: count(demo, /\/(?:workflow-callback|api\/autonomy\/callback)/gu),
	},
	{
		id: "demo-github-automation-secret",
		file: "apps/demo/src/index.ts",
		count: count(demo, /GITHUB_AUTOMATION_TOKEN/gu),
	},
	{
		id: "demo-callback-secret",
		file: "apps/demo/src/index.ts",
		count: count(demo, /AUTONOMY_CALLBACK_SECRET/gu),
	},
	{
		id: "demo-identity-secret",
		file: "apps/demo/src/index.ts",
		count: count(demo, /APP_HARNESS_IDENTITY_SECRET/gu),
	},
	{
		id: "demo-runner-and-github-bindings",
		file: "apps/demo/wrangler.jsonc",
		count: count(wrangler, /"binding"\s*:\s*"(?:OS_NATIVE_GIT_RUNNER|GITHUB_IDENTITY_BRIDGE)"/gu),
	},
];

const entries = new Map();
for (const entry of allowlist.entries) {
	assert.equal(typeof entry.id, "string", "each migration entry needs an id");
	assert.equal(typeof entry.file, "string", `migration entry ${entry.id} needs a file`);
	assert.ok(Number.isInteger(entry.expectedCount) && entry.expectedCount > 0, `migration entry ${entry.id} needs a positive exact count`);
	assert.equal(typeof entry.removal, "string", `migration entry ${entry.id} needs a removal criterion`);
	assert.ok(!entries.has(entry.id), `duplicate migration entry ${entry.id}`);
	entries.set(entry.id, entry);
}

for (const violation of observed) {
	const entry = entries.get(violation.id);
	if (violation.count === 0) {
		assert.equal(entry, undefined, `${violation.id} was removed; delete its migration allowlist entry too`);
		continue;
	}
	assert.ok(entry, `new control-plane violation: ${violation.id} (${violation.count} match(es)); remove it or explicitly inventory it in the temporary migration allowlist`);
	assert.equal(entry.file, violation.file, `migration entry ${violation.id} names the wrong file`);
	assert.equal(entry.expectedCount, violation.count, `${violation.id} changed from its explicit migration inventory (${entry.expectedCount} → ${violation.count}); do not grow the legacy control plane`);
	entries.delete(violation.id);
}

assert.equal(entries.size, 0, `stale migration allowlist entries: ${[...entries.keys()].join(", ")}`);
console.log(`control-plane boundary: ${observed.filter((violation) => violation.count > 0).length} explicitly inventoried migration violation(s)`);
