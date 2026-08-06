import assert from "node:assert/strict";
import { classifyOsRunnerResponse, createOsNativeGitJob } from "../src/os-provider-bridge.js";

const job = createOsNativeGitJob({
	workItemId: "work-42",
	issueUrl: "https://github.com/callil/autonomous-live-chat/issues/42",
});
assert.equal(job.repository, "callil/autonomous-live-chat");
assert.equal(job.stack.state, "awaiting-base-sha");
assert.deepEqual(job.audit, ["job-prepared", "repository-capability-requested"]);
assert.equal(classifyOsRunnerResponse({ state: "checked-out" }).phase, "building");
assert.equal(classifyOsRunnerResponse({ state: "credential-bridge-required" }).terminal, true);
assert.throws(() => createOsNativeGitJob({ workItemId: "work-42", issueUrl: "https://github.com/other/repo/issues/42" }));

console.log("OS provider bridge contracts passed");
