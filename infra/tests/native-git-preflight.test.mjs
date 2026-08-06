import assert from "node:assert/strict";
import { createNativeGitAuditEvent, prepareNativeGitJob } from "../orchestration/os-native-git-preflight.js";

const issueUrl = "https://github.com/callil/autonomous-live-chat/issues/42";
const plan = prepareNativeGitJob({
	workItemId: "work-42",
	room: "main",
	issueUrl,
	repository: "callil/autonomous-live-chat",
	stack: {
		id: "stack-42",
		rootIssueUrl: issueUrl,
		lane: "main",
		baseSha: "abc123",
		generation: 3,
		state: "needs-restack",
		nodes: [
			{ id: "slice-1", branch: "app-harness/42/01", intent: "first", state: "needs-restack" },
			{ id: "slice-2", branch: "app-harness/42/02", parentId: "slice-1", intent: "second", state: "needs-restack" },
		],
	},
	target: { targetId: "chat-composer" },
});

assert.equal(plan.mode, "preflight-only");
assert.equal(plan.credential.sandboxReceivesGitHubToken, false);
assert.equal(plan.stack.ci.concurrencyGroup, "app-harness-stack-stack-42");
assert.equal(plan.stack.ci.runKey, "app-harness-stack-stack-42-generation-3");
assert.deepEqual(plan.stack.restack.map((step) => step.base), ["main", "app-harness/42/01"]);

const audit = createNativeGitAuditEvent({
	jobId: plan.jobId,
	kind: "command-finished",
	nodeId: "slice-1",
	commandId: "run-typecheck",
	exitCode: 0,
	detail: "Typecheck completed.",
});
assert.equal(audit.commandId, "run-typecheck");
assert.throws(() => createNativeGitAuditEvent({ jobId: plan.jobId, kind: "command-finished", commandId: "rm-all" }));

console.log("native Git preflight contracts passed");
