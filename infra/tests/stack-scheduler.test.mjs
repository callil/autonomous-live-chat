import assert from "node:assert/strict";
import {
	markMainAdvanced,
	recordNodeState,
	restackFromRoot,
	stackConcurrencyKey,
	validateStack,
} from "../orchestration/stack-scheduler.js";

const stack = validateStack({
	id: "stack-demo",
	rootIssueUrl: "https://github.com/callil/autonomous-live-chat/issues/1",
	lane: "room-main",
	baseSha: "base-a",
	generation: 1,
	state: "ready",
	nodes: [
		{ id: "slice-1", branch: "agent/stack-demo/01", intent: "clarify copy", state: "ready" },
		{ id: "slice-2", branch: "agent/stack-demo/02", parentId: "slice-1", intent: "adjust spacing", state: "ready" },
	],
});

const stale = markMainAdvanced(stack, "base-b");
assert.equal(stale.state, "needs-restack");
assert.equal(stale.nodes[1].state, "needs-restack");

const restacked = restackFromRoot(stale, "base-b");
assert.equal(restacked.generation, 2);
assert.equal(restacked.baseSha, "base-b");
assert.equal(stackConcurrencyKey(restacked), "app-harness-stack-stack-demo-generation-2");

const failedRoot = recordNodeState(restacked, "slice-1", 2, "failed");
assert.equal(failedRoot.state, "blocked");
assert.equal(failedRoot.nodes[1].state, "blocked");
assert.equal(recordNodeState(failedRoot, "slice-1", 1, "passed").nodes[0].state, "failed");

console.log("stack scheduler transitions passed");
