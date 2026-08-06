import assert from "node:assert/strict";
import { classifyOsRunnerResponse, createOsNativeGitJob, createOsPlanningManifest } from "../src/os-provider-bridge.js";

const manifest = createOsPlanningManifest({
	workItemId: "work-42",
	issueUrl: "https://github.com/callil/autonomous-live-chat/issues/42",
	request: "Clarify the project intent in the README.",
});
const job = createOsNativeGitJob({ manifest, plan: { kind: "documentation-task", request: "Clarify the project intent in README." } });
assert.equal(job.repository, "callil/autonomous-live-chat");
assert.equal(job.candidate.stack.parentBranch, "main");
assert.equal(job.candidate.stack.parentBaseSha, null);
assert.equal(job.candidate.change.kind, "documentation-task");
assert.match(job.candidate.change.request, /Clarify/);
assert.equal(classifyOsRunnerResponse({ state: "checked-out" }).phase, "building");
assert.equal(classifyOsRunnerResponse({ state: "credential-bridge-required" }).terminal, true);
assert.equal(classifyOsRunnerResponse({ state: "pull-request-opened" }).terminal, false);
assert.throws(() => createOsNativeGitJob({ manifest, plan: { kind: "documentation-task", request: "" } }));
assert.throws(() => createOsPlanningManifest({ workItemId: "work-42", issueUrl: "https://github.com/other/repo/issues/42", request: "Clarify the README." }));

console.log("OS provider bridge contracts passed");
