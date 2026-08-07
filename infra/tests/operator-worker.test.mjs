import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { commandFor, OBSERVATION_TOOLS, STAGE_TOOLS, SYSTEM_PROMPT, TOOLS } from "../workers/operator/src/operator-tools.js";

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
assert.equal(TOOLS.length, 13, "the vocabulary is 6 observations + 7 stages; claim, release, and defer died with the lease machinery");
assert.equal(OBSERVATION_TOOLS.size, 6);
assert.equal(STAGE_TOOLS.size, 7);
for (const name of ["stageClaim", "stageRelease", "stageDefer", "listReady", "getWorkItem", "getAction", "listActions"]) {
	assert.ok(!TOOLS.some((entry) => entry.function.name === name), `${name} does not exist in the event-driven vocabulary`);
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
assert.deepEqual(Object.keys(TOOLS.find((candidate) => candidate.function.name === "stageImplementation").function.parameters.properties), [], "the implementation run identifier is minted by the loop, never the model");

// ---- system prompt: no lease ceremony, WAITING is a turn outcome ----
assert.ok(SYSTEM_PROMPT.length < 1_200, `system prompt stays compact (${SYSTEM_PROMPT.length} chars)`);
assert.match(SYSTEM_PROMPT, /classification -> issue -> plan -> implementation -> candidate -> validating -> promotion -> deployed -> completed/u);
assert.doesNotMatch(SYSTEM_PROMPT, /claim|lease|defer|stageRelease/iu, "no lease vocabulary survives the simplification");
assert.match(SYSTEM_PROMPT, /never poll getCandidate/u, "candidate results arrive by push");
assert.match(SYSTEM_PROMPT, /State\.facts\.runnerResult/u, "the prompt teaches the pushed runner fact");
assert.match(SYSTEM_PROMPT, /Stage from pushed State\.facts/u, "pushed GitHub facts are staged directly, never re-observed");
// ---- auto-merge fast lane: wait for merge facts; promotion is the fallback ----
assert.match(SYSTEM_PROMPT, /then WAIT: candidates auto-merge and deploy on their own/u, "after validating, the default is to wait for the fast lane, not dispatch promotion");
assert.match(SYSTEM_PROMPT, /facts\.merged and a success facts\.mainDeploy arrive, stageState deployed with both as artifacts, then completed/u, "the merge and main-deploy facts together are the fast-lane deployed evidence");
assert.match(SYSTEM_PROMPT, /stagePromotion is the fallback if no merged fact arrives after a long wait/u, "promotion dispatch is described as the fallback merge path");
const stageStateArtifacts = TOOLS.find((entry) => entry.function.name === "stageState").function.parameters.properties.artifacts;
assert.deepEqual(Object.keys(stageStateArtifacts.properties).toSorted(), ["mainDeploy", "merged", "promotion", "validation"], "stageState can carry every evidence artifact the deployed guard accepts");
assert.deepEqual(stageStateArtifacts.properties.merged.required.toSorted(), ["branch", "headSha", "mergeCommitSha", "number", "url"]);
assert.deepEqual(stageStateArtifacts.properties.mainDeploy.required.toSorted(), ["conclusion", "runId", "url"]);
assert.match(TOOLS.find((entry) => entry.function.name === "stagePromotion").function.description, /^Fallback merge path/u, "the tool description itself teaches promotion as fallback");
assert.match(SYSTEM_PROMPT, /only when the phase needs an answer and no fact is present/u, "observation tools are the fallback poll, not the data path");
assert.match(SYSTEM_PROMPT, /PROGRESSED, WAITING, PARKED:<code>, or COMPLETE/u, "a waiting turn simply ends; the DO re-drives itself");

// ---- commandFor: the loop injects run and stack identity ----
const ctx = { minted: "minted-uuid", activeRunId: "run-active", planBranch: "app-harness-os/7/g1", issueNumber: 7 };
assert.deepEqual(commandFor("stageImplementation", {}, ctx), { kind: "implement", runId: "minted-uuid" }, "the implementation run identifier is minted by the loop and doubles as the callback bearer credential");
const candidate = commandFor("stageCandidate", { headSha: "a".repeat(40), pullRequestNumber: 12, pullRequestUrl: "https://github.com/callil/autonomous-live-chat/pull/12", message: "Candidate ready." }, ctx);
assert.equal(candidate.runId, "run-active", "the candidate is bound to the active implementation run");
assert.equal(candidate.branch, "app-harness-os/7/g1");
assert.ok(!("leaseId" in candidate), "no command carries a lease");
const plan = commandFor("stagePlan", { baseSha: "b".repeat(40), generation: 2, summary: "One node.", ciProfile: "visual", message: "Planned." }, ctx);
assert.equal(plan.plan.nodeId, "root");
assert.equal(plan.plan.parentBaseSha, plan.plan.baseSha, "the one-node plan pins its parent base to the plan base");
assert.equal(plan.plan.issueNumber, 7, "the issue identity comes from the snapshot, not the model");
const fastLaneArtifacts = {
	validation: null,
	promotion: null,
	merged: { number: 12, url: "https://github.com/callil/autonomous-live-chat/pull/12", headSha: "a".repeat(40), mergeCommitSha: "c".repeat(40), branch: "app-harness-os/7/g1" },
	mainDeploy: { url: "https://github.com/callil/autonomous-live-chat/actions/runs/77", runId: 77, conclusion: "success" },
};
const fastLaneDeployed = commandFor("stageState", { phase: "deployed", artifacts: fastLaneArtifacts, message: "Deployed by auto-merge.", source: "github" }, ctx);
assert.deepEqual(fastLaneDeployed.artifacts, { merged: fastLaneArtifacts.merged, mainDeploy: fastLaneArtifacts.mainDeploy }, "the fast-lane evidence artifacts pass through stageState unmodified");
assert.throws(() => commandFor("stageClaim", {}, ctx), /Unknown operator stage tool/u, "claim is unrepresentable");
assert.throws(() => commandFor("stageDefer", { delayMs: 60_000, message: "wait" }, ctx), /Unknown operator stage tool/u, "defer is unrepresentable");
assert.throws(() => commandFor("inventedMethod", {}, ctx), /Unknown operator stage tool/u);

// ---- operator worker: event-driven turns with adaptive budgets ----
assert.match(operatorWorker, /snapshotWorkItem\(\{ workItemId \}\)/u, "each turn reads a fresh authoritative ledger snapshot at start");
assert.match(operatorWorker, /stageOperatorAction\(\{ workItemId: turn\.workItemId, expectedVersion: turn\.version, command \}\)/u, "every command is durably staged before execution");
assert.match(operatorWorker, /beginOperatorAction/u);
assert.match(operatorWorker, /completeOperatorAction/u);
assert.match(operatorWorker, /rejectOperatorAction/u, "execution failure is recorded as a ledger rejection the model sees in-turn");
assert.doesNotMatch(operatorWorker, /recordOperatorNote|wakeKey|responseLease|NOTE_RETRY|leaseId/u, "the note/wake settlement protocol died with the wake records");
assert.match(operatorWorker, /TURN_ENVELOPE_MS = 10 \* 60_000/u, "the generous outer envelope replaces the fixed turn wall clock");
assert.match(operatorWorker, /Date\.now\(\) - turn\.startedAt \+ MODEL_CALL_TIMEOUT_MS > TURN_ENVELOPE_MS/u, "before each model call the loop checks a bounded call still fits the envelope");
assert.match(operatorWorker, /OBSERVATION_TIMEOUT_MS/u, "observation tool calls carry their own timeout");
assert.match(operatorWorker, /STAGE_TIMEOUT_MS/u, "stage tool calls carry their own timeout");
assert.match(operatorWorker, /WAITING_REPOKE_MS = 60_000/u, "a WAITING turn re-drives itself by DO-local alarm, no ledger involvement");
assert.match(operatorWorker, /parallel_tool_calls|calls\.slice\(1\)/u, "parallel commands cannot race the single-active-action lock");
assert.match(operatorWorker, /setAlarm/u, "a crashed turn resumes from its persisted transcript by alarm");
assert.match(operatorWorker, /PARKED:tool-budget/u);
assert.match(operatorWorker, /PARKED:token-budget/u);
assert.match(operatorWorker, /PARKED:turn-envelope/u);
assert.match(operatorWorker, /PARKED:model-unavailable/u, "a dead provider parks the turn instead of failing the work item");
assert.match(operatorWorker, /\/status/u, "the read-only status endpoint stays");
assert.doesNotMatch(operatorWorker, /listReady|getWorkItem\(/u, "the DO is invoked for one work item; the snapshot is the read");

// ---- model calls: bounded, exported budget ----
const model = await read("../workers/operator/src/model.ts");
assert.match(model, /export const MODEL_CALL_TIMEOUT_MS = 45_000/u, "the model call budget is a named contract");
assert.match(model, /AbortSignal\.timeout\(MODEL_CALL_TIMEOUT_MS\)/u, "each model call carries its own deadline");

// ---- operator wrangler: capability surface unchanged ----
for (const [binding, service, entrypoint] of [
	["LEDGER", "autonomous-live-chat", "LedgerService"],
	["RUNNER", "app-harness-os-native-git", "NativeGitRunner"],
	["GITHUB", "app-harness-os-git-proxy", "GitHubAppCapability"],
]) {
	assert.match(operatorConfig, new RegExp(`"binding": "${binding}", "service": "${service}", "entrypoint": "${entrypoint}"`, "u"), `${binding} rides the same private service binding`);
}
assert.match(operatorConfig, /"MODEL_ID": "gpt-5\.4-nano"/u);
assert.match(operatorConfig, /"new_sqlite_classes": \["OperatorTurn"\]/u);
assert.doesNotMatch(operatorConfig, /"MODEL_API_KEY"/u, "the model credential is a wrangler secret, never a var");

// ---- demo transport: fire-and-forget pokes plus one safety-net sweep ----
assert.match(demoWorker, /submitWake\(\{ workItemId: item\.id \}\)/u, "a poke carries no state; the DO reads its own fresh snapshot");
assert.match(demoWorker, /pokeOperator/u, "every relevant ledger event pokes the operator");
assert.match(demoWorker, /this\.ctx\.waitUntil/u, "pokes are fire-and-forget, never awaited on the write path");
assert.match(demoWorker, /SWEEP_INTERVAL_MS = 2 \* 60_000/u, "one slow ledger-side sweep is the final safety net");
assert.match(demoWorker, /OPERATOR_POKE_CAP = 200/u, "the lifetime poke budget is the runaway brake");
assert.match(demoWorker, /needs_review/u, "the poke cap parks to needs_review instead of spinning");
assert.doesNotMatch(demoWorker, /WakeRecord|queueOperatorWakeRecord|beginOperatorWakeDelivery|settleOperatorWakeRecord|operatorWakeDeliveryExhausted|ledger-wake|recordOperatorNote|requireLease|leaseId|resumeAt/u, "no wake-record or lease machinery survives in the ledger");
assert.match(demoConfig, /"binding": "OPERATOR"/u);
assert.match(demoConfig, /"service": "app-harness-operator"/u);
assert.match(demoConfig, /"entrypoint": "OperatorGateway"/u);

// ---- failed-run restack: no stale evidence, restack is the next step ----
assert.match(demoWorker, /input\.phase === "retryable"/u, "the retryable transition triggers durable cleanup");
assert.match(demoWorker, /delete facts\.runnerResult;\n\t\t\t\tdelete facts\.runnerProgress;/u, "the dead generation's runner evidence is cleared with the retryable transition");
assert.match(demoWorker, /const nextStep = item\.phase === "retryable"/u, "a retryable snapshot names the restack as the single next step");
assert.match(demoWorker, /Stage a revised plan \(revision \$\{item\.plan \? item\.plan\.revision \+ 1 : 1\}, next generation, fresh getMainSha baseSha\) to restack\./u, "the guidance carries the exact next revision");
assert.match(SYSTEM_PROMPT, /phase retryable \(the failed run was already cleared\), restack/u, "the prompt teaches the retryable restack");
assert.match(SYSTEM_PROMPT, /never wait for a cleared run/u, "the wedge — waiting on a dead generation — is named and forbidden");

// ---- fast-lane facts: honest joins in the ledger and snapshot ----
assert.match(demoWorker, /matchGithubFactToWorkItem\(parsed\.fact, live, promotions, merges\)/u, "main-deploy matching receives the per-item merge commits");
assert.match(demoWorker, /facts\?\.merged\?\.mergeCommitSha/u, "the merge join key comes from each live item's recorded merged fact");
assert.match(demoWorker, /facts\.mainDeploy\.headSha === merged\.mergeCommitSha/u, "the snapshot only ever shows a deploy of this item's own merge commit");
assert.match(demoWorker, /candidateArtifact\?\.headSha === facts\.merged\.headSha/u, "the merged fact is gated by the recorded candidate's immutable head revision");

// ---- user-visible source label: never "cloudflare os" ----
assert.match(demoWorker, /source === "cloudflare-os" \? "operator" : source/u, "the stored enum stays for old records and maps to operator at projection time");

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

// ---- live agent observability: streamed JSONL events, bounded everywhere ----
assert.match(jobEntrypoint, /PROGRESS_BATCH_EVENTS = 10/u, "events flush at ten per batch");
assert.match(jobEntrypoint, /PROGRESS_BATCH_MS = 5_000/u, "or every five seconds, whichever comes first");
assert.match(jobEntrypoint, /onStdoutLine: queueProgressEvent/u, "the agent's JSONL stdout streams live, line by line");
assert.match(jobEntrypoint, /artifact: \{ progress: true, events \}/u, "event batches ride the same callback transport as heartbeats");
assert.match(jobEntrypoint, /flushProgressEvents\(\)/u, "the final partial batch is flushed after the agent step");
assert.match(demoWorker, /RUNNER_PROGRESS_EVENTS_KEPT = 30/u, "the ledger keeps a rolling last-30 tail under the runnerProgress fact");
assert.match(demoWorker, /runnerStepMessage/u, "the public feed gets a human line only on step transitions");
assert.match(demoWorker, /OPERATOR_STATE_PROGRESS_EVENTS/u, "the operator snapshot embeds a bounded tail of agent events");

console.log("event-driven operator vocabulary, transport, and live-progress contracts passed");
