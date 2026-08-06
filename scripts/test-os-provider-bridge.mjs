import assert from "node:assert/strict";
import { classifyOsRunnerResponse, createOsNativeGitJob, createOsPlanningManifest } from "../src/os-provider-bridge.js";

const manifest = createOsPlanningManifest({
	workItemId: "work-42",
	issueUrl: "https://github.com/callil/autonomous-live-chat/issues/42",
	request: "Change the accent color to purple.",
});
const job = createOsNativeGitJob({ manifest, plan: { kind: "accent-color", color: "purple" } });
assert.equal(job.repository, "callil/autonomous-live-chat");
assert.equal(job.candidate.stack.parentBranch, "main");
assert.equal(job.candidate.stack.parentBaseSha, null);
assert.equal(job.candidate.change.color, "purple");
assert.equal(classifyOsRunnerResponse({ state: "checked-out" }).phase, "building");
assert.equal(classifyOsRunnerResponse({ state: "credential-bridge-required" }).terminal, true);
assert.equal(classifyOsRunnerResponse({ state: "pull-request-opened" }).terminal, false);
assert.throws(() => createOsPlanningManifest({ workItemId: "work-42", issueUrl: "https://github.com/other/repo/issues/42", request: "Change the accent color to purple." }));

console.log("OS provider bridge contracts passed");
