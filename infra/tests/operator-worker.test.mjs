import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { commandFor, OBSERVATION_TOOLS, OPERATOR_LEASE_MS, PARKING_TOOLS, STAGE_TOOLS, SYSTEM_PROMPT, TOOLS } from "../workers/operator/src/operator-tools.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [operatorWorker, operatorConfig, demoWorker, demoConfig, runnerWorker, runnerConfig, jobEntrypoint] = await Promise.all([
	read("../workers/operator/src/index.ts"),
	read("../workers/operator/wrangler.jsonc"),
	read("../../apps/demo/src/index.ts"),
	read("../../apps/demo/wrangler.jsonc"),
	read("../workers/native-git-runner/src/index.ts"),
	read("../workers/native-git-runner/wrangler.jsonc"),
	read("../workers/native-git-runner/job-entrypoint.mjs"),
]);

// ---- tool vocabulary: strict schemas, loop-owned facts never model-facing ----
assert.equal(TOOLS.length, 16, "the pruned vocabulary is 6 observations + 10 stages");
assert.equal(OBSERVATION_TOOLS.size, 6);
assert.equal(STAGE_TOOLS.size, 10);
for (const name of ["listReady", "getWorkItem", "getAction", "listActions"]) {
	assert.ok(!TOOLS.some((entry) => entry.function.name === name), `${name} is dead weight for a per-item loop and stays internal`);
}
for (const entry of TOOLS) {
	const { name, strict, parameters } = entry.function;
	assert.equal(strict, true, `${name} must use strict constrained decoding`);
	assert.equal(parameters.type, "object");
	assert.equal(parameters.additionalProperties, false, `${name} must reject undeclared arguments`);
	assert.deepEqual(parameters.required.toSorted(), Object.keys(parameters.properties).toSorted(), `${name} strict mode requires every declared property`);
	for (const injected of ["workItemId", "expectedVersion", "leaseId", "jobId"]) {
		assert.ok(!(injected in parameters.properties), `${name} must not ask the model for loop-owned fact ${injected}`);
	}
}
for (const name of ["stageClaim", "stageImplementation"]) {
	const entry = TOOLS.find((candidate) => candidate.function.name === name);
	assert.deepEqual(Object.keys(entry.function.parameters.properties), [], `${name} identifiers are minted by the loop, never the model`);
}
assert.deepEqual([...PARKING_TOOLS].toSorted(), ["stageDefer", "stageRelease"]);
for (const name of PARKING_TOOLS) assert.ok(STAGE_TOOLS.has(name));

// ---- system prompt: schemas subsume the old 2,700-character instruction ----
assert.ok(SYSTEM_PROMPT.length < 1_200, `system prompt stays compact (${SYSTEM_PROMPT.length} chars)`);
assert.match(SYSTEM_PROMPT, /claim -> classification -> issue -> plan -> implementation -> candidate -> validating -> promotion -> deployed -> completed/u);
assert.match(SYSTEM_PROMPT, /stageRelease and stageDefer are parking exits: after either, stop/u);
assert.match(SYSTEM_PROMPT, /never poll getCandidate/u, "candidate results arrive by push");
assert.match(SYSTEM_PROMPT, /State\.facts\.runnerResult/u, "the prompt teaches the pushed runner fact");
assert.doesNotMatch(SYSTEM_PROMPT, /APP_HARNESS_2|env\.APP_HARNESS/u, "no binding-discovery workarounds survive the migration");

// ---- commandFor: the loop injects lease, run, and stack identity ----
const ctx = { leaseId: "lease-live", minted: "minted-uuid", activeRunId: "run-active", planBranch: "app-harness-os/7/g1", issueNumber: 7 };
assert.deepEqual(commandFor("stageClaim", {}, ctx), { kind: "claim", leaseId: "minted-uuid", leaseMs: OPERATOR_LEASE_MS }, "claim mints a fresh high-entropy lease");
assert.deepEqual(commandFor("stageImplementation", {}, ctx), { kind: "implement", leaseId: "lease-live", runId: "minted-uuid" }, "the implementation run identifier is minted by the loop and doubles as the callback bearer credential");
const candidate = commandFor("stageCandidate", { headSha: "a".repeat(40), pullRequestNumber: 12, pullRequestUrl: "https://github.com/callil/autonomous-live-chat/pull/12", message: "Candidate ready." }, ctx);
assert.equal(candidate.runId, "run-active", "the candidate is bound to the active implementation run");
assert.equal(candidate.branch, "app-harness-os/7/g1");
const plan = commandFor("stagePlan", { baseSha: "b".repeat(40), generation: 2, summary: "One node.", ciProfile: "visual", message: "Planned." }, ctx);
assert.equal(plan.plan.nodeId, "root");
assert.equal(plan.plan.parentBaseSha, plan.plan.baseSha, "the one-node plan pins its parent base to the plan base");
assert.equal(plan.plan.issueNumber, 7, "the issue identity comes from the snapshot, not the model");
assert.throws(() => commandFor("inventedMethod", {}, ctx), /Unknown operator stage tool/u);

// ---- operator worker: durable log first, note settles the wake record ----
assert.match(operatorWorker, /stageOperatorAction\(\{ workItemId: turn\.workItemId, expectedVersion: turn\.version, command \}\)/u, "every command is durably staged before execution");
assert.match(operatorWorker, /beginOperatorAction/u);
assert.match(operatorWorker, /completeOperatorAction/u);
assert.match(operatorWorker, /rejectOperatorAction/u, "execution failure is recorded as a ledger rejection the model sees in-turn");
assert.match(operatorWorker, /recordOperatorNote/u, "the turn outcome settles the demo's wake record over plain RPC");
assert.match(operatorWorker, /expectedVersion: turn\.wakeVersion/u, "the note settles against the delivered wake revision, not the advanced one");
assert.match(operatorWorker, /parallel_tool_calls|calls\.slice\(1\)/u, "parallel commands cannot race the single-active-action lock");
assert.match(operatorWorker, /setAlarm/u, "a crashed turn resumes from its persisted transcript by alarm");
assert.match(operatorWorker, /PARKED:tool-budget/u);
assert.match(operatorWorker, /PARKED:token-budget/u);
assert.match(operatorWorker, /PARKED:time-budget/u);
assert.match(operatorWorker, /PARKED:model-unavailable/u, "a dead provider parks the turn instead of failing the work item");
assert.match(operatorWorker, /\/status/u, "the read-only status endpoint replaces the chat UI");
assert.doesNotMatch(operatorWorker, /listReady|getWorkItem\(/u, "the DO is invoked for one work item; the snapshot is the read");

// ---- operator wrangler: capability surface identical to the gatekeeper ----
for (const [binding, service, entrypoint] of [
	["LEDGER", "autonomous-live-chat", "LedgerService"],
	["RUNNER", "app-harness-os-native-git", "NativeGitRunner"],
	["GITHUB", "app-harness-os-git-proxy", "GitHubAppCapability"],
]) {
	assert.match(operatorConfig, new RegExp(`"binding": "${binding}", "service": "${service}", "entrypoint": "${entrypoint}"`, "u"), `${binding} rides the same private service binding as the gatekeeper did`);
}
assert.match(operatorConfig, /"MODEL_ID": "gpt-5\.4-nano"/u);
assert.match(operatorConfig, /"new_sqlite_classes": \["OperatorTurn"\]/u);
assert.doesNotMatch(operatorConfig, /"MODEL_API_KEY"/u, "the model credential is a wrangler secret, never a var");
assert.doesNotMatch(operatorConfig, /allow_irrevocable_stub_storage/u);

// ---- demo transport: structured wakes, no Cloudflare OS chat protocol ----
assert.doesNotMatch(demoWorker, /submitExternalMessage|chatGatewayRpcTarget|OPERATOR_INSTRUCTION|OPERATOR_GADGET_KEY|OPERATOR_CHAT_KEY|this\.ctx\.restore\(|RpcTarget|RpcStub/u, "the demo no longer speaks the Cloudflare OS chat protocol");
assert.match(demoWorker, /submitWake\(\{/u);
assert.match(demoWorker, /wakeKey = `ledger-event:\$\{inFlight\.id\}:v\$\{inFlight\.version\}:t\$\{inFlight\.turn\}`/u, "the wake keeps its per-revision, per-turn idempotency key");
assert.match(demoConfig, /"binding": "OPERATOR"/u);
assert.match(demoConfig, /"service": "app-harness-operator"/u);
assert.match(demoConfig, /"entrypoint": "OperatorGateway"/u);
assert.doesNotMatch(demoConfig, /allow_irrevocable_stub_storage|OS_WORKSPACE|app-harness-os"/u);

// ---- runner completion push: minted bearer credential end to end ----
assert.match(runnerWorker, /ledgerRunId/u, "startRun carries the ledger's per-run bearer credential");
assert.match(runnerWorker, /LEDGER_CALLBACK_URL/u);
assert.match(runnerWorker, /callback/u);
assert.match(jobEntrypoint, /CALLBACK_TIMEOUT_MS = 15_000/u);
assert.match(jobEntrypoint, /AbortSignal\.timeout\(CALLBACK_TIMEOUT_MS\)/u, "the completion POST is bounded");
assert.match(jobEntrypoint, /await postCallback\(result\)/u, "the terminal artifact is pushed after it is emitted");
assert.match(jobEntrypoint, /function safeCallback/u);
assert.match(runnerConfig, /"LEDGER_CALLBACK_URL": "https:\/\/autonomous-live-chat\.coda-a\.workers\.dev\/api\/runner\/complete"/u);
assert.match(demoWorker, /\/api\/runner\/complete/u);
assert.match(demoWorker, /ingestExternalFact/u, "the runner callback is the first caller of the general external-fact ingest");
assert.match(demoWorker, /item\.activeImplementation\?\.runId !== parsed\.runId/u, "the pushed fact must present the active run's bearer credential");
assert.match(demoWorker, /facts\.runnerResult\?\.runId === parsed\.runId/u, "fact ingestion is idempotent per run identifier");
assert.match(demoWorker, /source !== "runner"/u, "only declared fact sources are accepted");

console.log("pure-Workers operator vocabulary, transport, and runner push contracts passed");
