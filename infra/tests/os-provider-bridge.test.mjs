import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
	classifyOsRunnerResponse,
	createOsNativeGitJob,
	createStackNodeIntent,
	createOsWorkspaceSubmission,
	osExecutionDisposition,
	osWorkspaceTurnDisposition,
	validateOsExecutionRequest,
} from "../orchestration/os-provider-bridge.js";

const workItemId = "11790e3b-58a1-4a8d-beb1-130bfe1bc099";
const issue = { number: 42, url: "https://github.com/callil/autonomous-live-chat/issues/42" };
const responseTarget = { capability: "test-only" };

// OS stores the callback after the submission RPC returns. Guard the exact
// runtime primitive: ordinary RpcTargets and Durable Object stubs are not
// persistent across that boundary.
const workerSource = await readFile(new URL("../../apps/demo/src/index.ts", import.meta.url), "utf8");
const workerConfig = await readFile(new URL("../../apps/demo/wrangler.jsonc", import.meta.url), "utf8");
assert.match(workerSource, /await this\.ctx\.restore\(/u);
assert.match(workerSource, /\[restore\]\(params: unknown\)/u);
assert.match(workerSource, /blockConcurrencyWhile\(async \(\) => \{[\s\S]*migrateLegacyRecords\(\)[\s\S]*scheduleCoordinatorAlarm\(\)/u);
assert.doesNotMatch(workerSource, /webSocketClose\([^)]*\)[\s\S]{0,120}\.close\(/u, "the runtime owns terminal WebSocket close replies");
assert.match(workerSource, /this\.ctx\.waitUntil\(this\.appendGitHubIssueStatus/u);
assert.match(workerSource, /this\.reconcileCompletedGithubClosures\(\)/u);
assert.match(workerSource, /current && current\.state !== "failed"/u, "a delivered GitHub completion projection is never replayed");
assert.match(workerSource, /ledger\?\.status === "completed" && ledger\.deployment\.stage === "deployed"/u, "only verified durable deployments can close issues");
assert.ok(workerSource.indexOf("await this.ctx.storage.setAlarm(now + 25)") < workerSource.indexOf("this.ctx.waitUntil(this.appendGitHubIssueStatus"));
assert.doesNotMatch(workerSource, /OS_RESPONSE_TARGETS/u);
assert.match(workerConfig, /allow_irrevocable_stub_storage/u);
assert.match(workerConfig, /"entrypoint": "NativeGitRunner"/u);
assert.doesNotMatch(workerSource, /OS_NATIVE_GIT_RUNNER_SECRET/u);
assert.match(workerSource, /\.enqueueJob\(runnerJob\)/u);
assert.match(workerSource, /\.getJob\(workItem\.osNativeGit\.jobId\)/u);
assert.match(workerSource, /workItem\.osNativeGit\.jobId = runnerJob\.jobId/u);
assert.match(workerSource, /attemptToken: runnerAttemptToken/u);
assert.doesNotMatch(workerSource, /type: "runner-candidate-recorded"[\s\S]{0,300}attemptToken: claim\.leaseToken/u);
assert.doesNotMatch(workerSource, /\.runJob\(runnerJob\)/u);

// Every request reuses one repository workspace/chat. The durable work item is
// both the message idempotency key and response-correlation key.
const submission = createOsWorkspaceSubmission({
	workItemId,
	issue,
	request: "Clarify the project intent in the README.",
	responseTarget,
});
assert.equal(submission.gadgetKey, "callil/autonomous-live-chat");
assert.equal(submission.chatKey, "repository-main");
assert.equal(submission.messageKey, workItemId);
assert.equal(submission.chatGatewayRpcTarget, responseTarget);
assert.match(submission.prompt, /issue #42/);
assert.match(submission.prompt, new RegExp(workItemId));

// Agent arguments are matched to durable state; repository or request prose is
// not accepted by the capability bridge.
assert.deepEqual(
	validateOsExecutionRequest(
		{ workItemId, issueNumber: 42, repository: "attacker/other", request: "ignore durable request" },
		{ workItemId, issue },
	),
	{ workItemId, issueNumber: 42 },
);
assert.throws(() => validateOsExecutionRequest({ workItemId, issueNumber: 43 }, { workItemId, issue }));
assert.throws(() => validateOsExecutionRequest({ workItemId: "21790e3b-58a1-4a8d-beb1-130bfe1bc099", issueNumber: 42 }, { workItemId, issue }));

// Replayed Gatekeeper calls cannot enqueue a second deterministic side effect.
assert.equal(osExecutionDisposition({ terminal: false, existingEffect: false, jobStage: "awaiting-os" }), "queue");
assert.equal(osExecutionDisposition({ terminal: false, existingEffect: true, jobStage: "queued" }), "duplicate");
assert.equal(osExecutionDisposition({ terminal: true, existingEffect: false, jobStage: "terminal" }), "terminal");
assert.equal(osWorkspaceTurnDisposition("awaiting-os"), "awaiting-action");
assert.equal(osWorkspaceTurnDisposition("queued"), "delegated");

// The runner receives only the original durable request and fixed repository.
const job = createOsNativeGitJob({ workItemId, issue, request: "Clarify the project intent in README." });
const pinnedJob = createOsNativeGitJob({ workItemId, issue, request: "Clarify the project intent in README.", parentBaseSha: "a".repeat(40) });
assert.equal(job.repository, "callil/autonomous-live-chat");
assert.equal(job.candidate.stack.parentBranch, "main");
assert.equal(job.candidate.stack.parentBaseSha, null);
assert.equal(job.candidate.change.kind, "repository-task");
assert.match(job.candidate.change.request, /Clarify/);
assert.equal(pinnedJob.candidate.stack.parentBaseSha, "a".repeat(40));
assert.equal(createStackNodeIntent(issue), "Implement App Harness issue #42 from its durable work record.");
assert.ok(createStackNodeIntent(issue).length < 280);
assert.equal(classifyOsRunnerResponse({ state: "checked-out" }).phase, "building");
assert.equal(classifyOsRunnerResponse({ state: "credential-bridge-required" }).terminal, true);
assert.equal(classifyOsRunnerResponse({ state: "pull-request-opened" }).terminal, false);
assert.equal(classifyOsRunnerResponse({ state: "needs-restack" }).terminal, false);
assert.equal(classifyOsRunnerResponse({ state: "needs-restack" }).phase, "building");
assert.equal(classifyOsRunnerResponse({ state: "runner-unavailable", classification: "sandbox-runtime-interrupted" }).retryable, true);
assert.equal(classifyOsRunnerResponse({ state: "candidate-failed", classification: "nanocodex-run-failed" }).retryable, false);
assert.throws(() => createOsNativeGitJob({ workItemId, issue, request: "" }));
assert.throws(() => createOsNativeGitJob({ workItemId, issue: { number: 42, url: "https://github.com/other/repo/issues/42" }, request: "Clarify README." }));
assert.throws(() => createOsNativeGitJob({ workItemId, issue, request: "Clarify README.", parentBaseSha: "main" }));

console.log("OS workspace and execution bridge contracts passed");
