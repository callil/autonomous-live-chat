import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const ports = await readFile(new URL("../src/ports.ts", import.meta.url), "utf8");
const wrangler = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const firewall = await readFile(new URL("../../.github/workflows/platform-firewall.yml", import.meta.url), "utf8");

test("the platform worker never imports the legacy operator machinery", () => {
	for (const source of [worker, ports]) {
		assert.doesNotMatch(source, /@app-harness\/(demo|operator|contracts)/u, "the rebuild ports patterns, not modules");
		assert.doesNotMatch(source, /apps\/demo|infra\/workers|infra\/orchestration/u);
		assert.doesNotMatch(source, /OperatorGateway|LedgerService|ChatRoom/u);
	}
});

test("owner levers fail closed on the ADMIN_TOKEN bearer secret", () => {
	assert.match(worker, /pathname\.startsWith\("\/api\/admin\/"\)/u);
	assert.match(worker, /if \(!token \|\| request\.headers\.get\("Authorization"\) !== `Bearer \$\{token\}`\) return new Response\("Unauthorized", \{ status: 401 \}\);/u);
	assert.match(worker, /"\/api\/admin\/freeze"/u);
	assert.match(worker, /"\/api\/admin\/revert"/u);
});

test("the runner callback is guarded by runId-as-bearer plus the attempt ID zombie guard", () => {
	assert.match(worker, /"\/api\/runner\/complete"/u);
	assert.match(worker, /assertLiveAttempt\(queue, \{ runId, attemptId \}\)/u);
	assert.match(worker, /outcome\.accepted \? 200 : 403/u);
});

test("pokes only set the dirty mark; the level-triggered reconciler drives the delta", () => {
	assert.match(worker, /async poke\(\)/u);
	assert.match(worker, /DIRTY_KEY, true/u);
	assert.match(worker, /RECONCILE_INTERVAL_MS = 60_000/u);
	assert.match(worker, /await this\.reconcile\(\);\s*await this\.scheduleReconcile\(Date\.now\(\) \+ RECONCILE_INTERVAL_MS\);/u, "the alarm reconciles then reschedules the steady cadence");
});

test("phase-2 seams are stubbed ports, not half-built integrations", () => {
	assert.match(ports, /interface RunnerPort/u);
	assert.match(ports, /interface DoctorPort/u);
	assert.match(ports, /class StubRunnerPort/u);
	assert.match(ports, /class StubDoctorPort/u);
	assert.match(ports, /TODO\(phase 2\)/u);
	assert.match(worker, /new StubRunnerPort\(\)/u);
	assert.match(worker, /new StubDoctorPort\(\)/u);
});

test("the worker uses websocket hibernation, not in-memory socket bookkeeping", () => {
	assert.match(worker, /this\.ctx\.acceptWebSocket\(server\)/u);
	assert.match(worker, /this\.ctx\.getWebSockets\(\)/u);
	assert.doesNotMatch(worker, /addEventListener\("message"/u);
});

test("wrangler config declares the RoomDO as a new sqlite class with nodejs compat", () => {
	assert.match(wrangler, /"name": "app-harness-platform"/u);
	assert.match(wrangler, /"new_sqlite_classes":\s*\[\s*"RoomDO"\s*\]/u);
	assert.match(wrangler, /"nodejs_compat"/u);
	assert.match(wrangler, /ROOM_DAILY_BUDGET_USD/u);
	assert.doesNotMatch(wrangler, /ADMIN_TOKEN/u, "the admin token is a secret, never a var");
});

test("the firewall fails agent diffs touching platform, CI, manifests, lockfiles, or wrangler configs", () => {
	assert.match(firewall, /^on:\n  pull_request:$/mu);
	assert.match(firewall, /room\/\*\)/u, "only room/* agent branches are firewalled");
	assert.match(firewall, /platform\/\*/u);
	assert.match(firewall, /\.github\/\*/u);
	assert.match(firewall, /\*\/package\.json/u);
	assert.match(firewall, /\*\/package-lock\.json/u);
	assert.match(firewall, /pnpm-lock\.yaml/u);
	assert.match(firewall, /\*\/wrangler\.jsonc/u);
	assert.match(firewall, /wrangler\.toml/u);
	assert.match(firewall, /exit 1/u);
	assert.match(firewall, /persist-credentials: false/u);
});
