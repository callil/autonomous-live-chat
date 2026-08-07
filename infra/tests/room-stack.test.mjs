import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
	appendReservedNode,
	canonicalStackPlan,
	isStaleStackNode,
	markNodeRetargeted,
	normalizeRoomStack,
	pinStackNode,
	popBottomNode,
	stackNodeContext,
	stackTipPinned,
	truncateStack,
} from "../../packages/contracts/room-stack.js";
import { extractGithubWebhookFact } from "../../packages/contracts/webhook.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

// ==== Normalization: garbage in, one bounded empty record out ====

const EMPTY = { stackId: null, baseSha: null, order: [], tip: null, stale: [] };
assert.deepEqual(normalizeRoomStack(undefined), EMPTY, "an absent record normalizes to the empty stack");
assert.deepEqual(normalizeRoomStack({ order: "nope", stale: 7, stackId: 3 }), EMPTY, "malformed fields normalize away");
assert.deepEqual(
	normalizeRoomStack({ stackId: "stack-x", order: [{ workItemId: "item-a", nodeId: "root", branch: "bad..branch", parentBranch: "main" }] }),
	EMPTY,
	"an unsafe branch drops the node instead of trusting it",
);

// ==== Append: the root node starts a stack epoch ====

const rootNode = { workItemId: "item-a", nodeId: "root", branch: "app-harness-os/10/g1", parentBranch: "main", parentBaseSha: A, stackId: "stack-item-a" };
const rooted = appendReservedNode(undefined, rootNode);
assert.equal(rooted.appended, true, "a root node appends onto an empty stack");
assert.equal(rooted.stack.stackId, "stack-item-a", "the root append opens the stack epoch");
assert.equal(rooted.stack.baseSha, A, "the epoch records the main sha under the bottom node");
assert.deepEqual(rooted.stack.tip, { branch: "app-harness-os/10/g1", headSha: null }, "the fresh node is the reserved tip");
assert.equal(rooted.stack.order[0].headSha, null, "a reserved node has no head yet");

// The tip-pinning rule: a reserved tip blocks everyone except its own item.
assert.equal(stackTipPinned(undefined), true, "an empty stack is trivially pinned");
assert.equal(stackTipPinned(rooted.stack), false, "a reserved tip is not pinned");
assert.equal(stackTipPinned(rooted.stack, "item-a"), true, "the item holding the reserved tip is exempt: its own run is what pins it");
assert.equal(stackTipPinned(rooted.stack, "item-b"), false, "any other item waits for the pin");

// A dependent append is refused while the tip is reserved.
const early = appendReservedNode(rooted.stack, { workItemId: "item-b", nodeId: "n-item-b", branch: "app-harness-os/11/g1", parentBranch: "app-harness-os/10/g1", parentBaseSha: B, stackId: "stack-item-a" });
assert.equal(early.appended, false);
assert.equal(early.reason, "tip-unpinned", "no node stacks on an unknowable parent revision");

// ==== Pin: the candidate head unblocks the next dependent plan ====

const pinned = pinStackNode(rooted.stack, "item-a", B);
assert.equal(pinned.pinned, true);
assert.deepEqual(pinned.stack.tip, { branch: "app-harness-os/10/g1", headSha: B }, "the pin rides the tip");
assert.equal(stackTipPinned(pinned.stack), true);
assert.equal(pinStackNode(pinned.stack, "item-missing", C).pinned, false, "pinning an unknown node changes nothing");

const stacked = appendReservedNode(pinned.stack, { workItemId: "item-b", nodeId: "n-item-b", branch: "app-harness-os/11/g1", parentBranch: "app-harness-os/10/g1", parentBaseSha: B, stackId: "stack-item-a" });
assert.equal(stacked.appended, true, "a dependent node appends onto the pinned tip");
assert.equal(stacked.stack.order.length, 2);
assert.equal(stacked.stack.order[1].parentBaseSha, B, "the dependent node records the parent's immutable head");

// Append re-verifies the recorded parent against the live tip.
assert.equal(appendReservedNode(stacked.stack, { ...rootNode, workItemId: "item-c", nodeId: "n-item-c", branch: "app-harness-os/12/g1" }).reason, "stack-not-empty", "a root plan staged against a stack that has since grown is refused");
const wrongParent = appendReservedNode(pinStackNode(stacked.stack, "item-b", C).stack, { workItemId: "item-d", nodeId: "n-item-d", branch: "app-harness-os/13/g1", parentBranch: "app-harness-os/10/g1", parentBaseSha: B, stackId: "stack-item-a" });
assert.equal(wrongParent.reason, "tip-mismatch", "a plan whose recorded parent is no longer the tip is refused");
assert.equal(appendReservedNode(pinned.stack, { ...rootNode, workItemId: "item-a" }).reason, "node-exists", "an item appends at most one node; a replan truncates first");

// ==== Truncate: the cascade-restack transform ====

const threeDeep = appendReservedNode(pinStackNode(stacked.stack, "item-b", C).stack, { workItemId: "item-c", nodeId: "n-item-c", branch: "app-harness-os/12/g1", parentBranch: "app-harness-os/11/g1", parentBaseSha: C, stackId: "stack-item-a" }).stack;
assert.equal(threeDeep.order.length, 3);

const truncated = truncateStack(threeDeep, "item-b");
assert.equal(truncated.removed, true);
assert.deepEqual(truncated.stack.order.map((node) => node.workItemId), ["item-a"], "the truncated node and everything above leave the linear order");
assert.deepEqual(truncated.staleWorkItemIds, ["item-c"], "every node above the truncated one is a stale survivor");
assert.equal(isStaleStackNode(truncated.stack, "item-c"), true, "the survivor stays marked until it replans or ends");
assert.equal(isStaleStackNode(truncated.stack, "item-a"), false);
assert.deepEqual(truncated.stack.tip, { branch: "app-harness-os/10/g1", headSha: B }, "the tip rolls back to the highest surviving pinned node");

// A stale survivor that ends clears its marking; nothing else changes.
const staleCleared = truncateStack(truncated.stack, "item-c");
assert.equal(staleCleared.removed, true);
assert.equal(isStaleStackNode(staleCleared.stack, "item-c"), false);
assert.deepEqual(staleCleared.staleWorkItemIds, [], "clearing a stale marking marks nothing new");
assert.equal(truncateStack(staleCleared.stack, "item-nowhere").removed, false, "truncating an item that holds nothing reports removed: false");

// Truncating the last node resets the record: the next plan opens a new epoch.
assert.deepEqual(truncateStack(staleCleared.stack, "item-a").stack, EMPTY, "an emptied stack resets for the next epoch");

// ==== Pop: the cascade's forward step after the bottom node merges ====

const popped = popBottomNode(threeDeep, "item-a", D);
assert.equal(popped.popped, true);
assert.deepEqual(popped.stack.order.map((node) => node.workItemId), ["item-b", "item-c"], "only the bottom node pops");
assert.equal(popped.stack.baseSha, D, "the recorded base advances to the merge commit");
assert.equal(popped.stack.stackId, "stack-item-a", "the epoch continues for the survivors");
assert.equal(popBottomNode(threeDeep, "item-b", D).popped, false, "a non-bottom node can never pop");
assert.deepEqual(popBottomNode(rooted.stack, "item-a", D).stack, EMPTY, "popping the only node ends the epoch");

// ==== Retarget marking and merge-train coordinates ====

// Marking only sets the flag: tip, order, head shas, and the recorded parent
// stay byte-identical, because the survivor's unchanged provenance is exactly
// what the gate's ancestor-of-main rule verifies.
const markable = pinStackNode(stacked.stack, "item-b", C).stack;
const marked = markNodeRetargeted(markable, "item-b");
assert.equal(marked.marked, true);
assert.equal(marked.stack.order[1].retargeted, true, "only the marker changes");
assert.deepEqual({ ...marked.stack.order[1], retargeted: undefined }, { ...markable.order[1], retargeted: undefined }, "every other node field is untouched");
assert.deepEqual(marked.stack.tip, markable.tip, "the tip is untouched by a retarget");
assert.equal(markNodeRetargeted(marked.stack, "item-b").marked, false, "marking is idempotent");
assert.equal(markNodeRetargeted(marked.stack, "item-missing").marked, false, "marking an absent node changes nothing");
assert.equal(normalizeRoomStack(JSON.parse(JSON.stringify(marked.stack))).order[1].retargeted, true, "the marker survives persistence and normalization");

assert.deepEqual(stackNodeContext(marked.stack, "item-a"), { position: 1, size: 2, expectedOrder: [], retargeted: false }, "the bottom node's context has nothing beneath it");
assert.deepEqual(stackNodeContext(marked.stack, "item-b"), { position: 2, size: 2, expectedOrder: ["app-harness-os/10/g1"], retargeted: true }, "an upper node's context carries the exact branch order beneath it and its retarget marker");
assert.equal(stackNodeContext(marked.stack, "item-missing"), null, "an unstacked item has no merge-train coordinates");

// ==== End to end: two queued items ride one stack; the bottom merges ====

// Two queued requests build the two-node record exactly as the room does:
// root plan appended reserved, pinned by its candidate, dependent plan
// appended on the pinned tip, pinned by its own candidate.
const MERGE_COMMIT = "e".repeat(40);
let train = appendReservedNode(undefined, { workItemId: "item-first", nodeId: "root", branch: "app-harness-os/20/g1", parentBranch: "main", parentBaseSha: A, stackId: "stack-epoch" }).stack;
train = pinStackNode(train, "item-first", B).stack;
train = appendReservedNode(train, { workItemId: "item-second", nodeId: "n-second00", branch: "app-harness-os/21/g1", parentBranch: "app-harness-os/20/g1", parentBaseSha: B, stackId: "stack-epoch" }).stack;
train = pinStackNode(train, "item-second", C).stack;
assert.deepEqual(train.order.map((node) => node.workItemId), ["item-first", "item-second"], "two queued items form a two-node record");
assert.deepEqual(stackNodeContext(train, "item-second").expectedOrder, ["app-harness-os/20/g1"], "the second item's runner topology assertion is the branch below it");

// The bottom node's PR merges: the webhook merged fact pops it and advances
// the base; the survivor's stacked (retarget) fact only marks it.
const mergedFact = extractGithubWebhookFact({
	event: "pull_request",
	payload: { action: "closed", pull_request: { number: 71, html_url: "https://github.com/callil/autonomous-live-chat/pull/71", merged: true, merge_commit_sha: MERGE_COMMIT, head: { ref: "app-harness-os/20/g1", sha: B } } },
});
const poppedTrain = popBottomNode(train, "item-first", mergedFact.mergeCommitSha);
assert.equal(poppedTrain.popped, true, "the merged fact pops the bottom node");
assert.equal(poppedTrain.stack.baseSha, MERGE_COMMIT, "the recorded base advances to the merge commit");
assert.deepEqual(poppedTrain.stack.order.map((node) => node.workItemId), ["item-second"], "the survivor is the new bottom");
assert.deepEqual(poppedTrain.stack.tip, { branch: "app-harness-os/21/g1", headSha: C }, "the survivor's pinned tip is untouched: zero regeneration");

const retargetFact = extractGithubWebhookFact({
	event: "pull_request",
	payload: { action: "stacked", stack: { position: 1, size: 1 }, pull_request: { number: 72, html_url: "https://github.com/callil/autonomous-live-chat/pull/72", head: { ref: "app-harness-os/21/g1", sha: C }, base: { ref: "main" } } },
});
assert.equal(retargetFact.base, "main", "GitHub retargeted the survivor to main");
const survivorNode = poppedTrain.stack.order[0];
assert.notEqual(survivorNode.parentBranch, retargetFact.base, "the fact's base no longer names the recorded parent: this is the retarget");
const retargetedTrain = markNodeRetargeted(poppedTrain.stack, "item-second").stack;
assert.equal(retargetedTrain.order[0].retargeted, true, "the survivor is marked retargeted");
assert.equal(retargetedTrain.order[0].parentBranch, "app-harness-os/20/g1", "the recorded parent provenance is untouched — the gate's ancestor rule carries it");
assert.equal(isStaleStackNode(retargetedTrain, "item-second"), false, "a retargeted survivor is NOT stale: no replan, no new generation");
assert.deepEqual(stackNodeContext(retargetedTrain, "item-second"), { position: 1, size: 1, expectedOrder: [], retargeted: true }, "the survivor is now the bottom: it may promote");

// ==== canonicalStackPlan: the empty stack is byte-identical to today ====

// Verbatim copy of the historical one-node derivation this transform replaces
// (apps/demo/src/index.ts canonicalOneNodePlan on origin/main): with an empty
// stack the shared-stack derivation must be indistinguishable, byte for byte.
function legacyCanonicalOneNodePlan(item, plan) {
	const issue = item.artifacts?.issue;
	const issueNumber = Number.isSafeInteger(issue?.number) && issue.number >= 1 ? issue.number : plan.issueNumber;
	const priorCandidate = item.artifacts?.candidate;
	const floor = Number.isSafeInteger(priorCandidate?.generation) ? priorCandidate.generation + 1 : 1;
	const generation = Math.max(floor, Number.isSafeInteger(plan.generation) && plan.generation >= 1 ? plan.generation : 1);
	const baseSha = typeof plan.baseSha === "string" ? plan.baseSha : "";
	return {
		...plan,
		revision: item.plan ? item.plan.revision + 1 : 1,
		generation,
		issueNumber,
		nodeId: "root",
		parentBranch: "main",
		pullRequestBase: "main",
		parentBaseSha: baseSha,
		branch: `app-harness-os/${issueNumber}/g${generation}`,
		stackId: typeof plan.stackId === "string" && plan.stackId.trim() ? plan.stackId : `stack-${item.id.slice(0, 8)}`,
	};
}

function modelPlan(overrides = {}) {
	// The exact placeholder shape commandFor("stagePlan") stages today.
	return {
		revision: 1,
		baseSha: A,
		stackId: "",
		generation: 1,
		nodeId: "root",
		branch: "pending",
		parentBranch: "main",
		parentBaseSha: A,
		pullRequestBase: "main",
		issueNumber: 10,
		summary: "Update the heading",
		ciProfile: "content",
		...overrides,
	};
}

const freshItem = { id: "0f0e0d0c-0b0a-4908-8706-050403020100", plan: null, artifacts: { issue: { number: 10, url: "https://github.com/callil/autonomous-live-chat/issues/10" } } };
const replanItem = {
	...freshItem,
	plan: { ...modelPlan(), revision: 3, generation: 2, branch: "app-harness-os/10/g2" },
	artifacts: { ...freshItem.artifacts, candidate: { generation: 2 } },
};
for (const [label, item, plan] of [
	["a fresh plan", freshItem, modelPlan()],
	["a replan over a prior candidate", replanItem, modelPlan({ generation: 1 })],
	["a model-provided stack id", freshItem, modelPlan({ stackId: "stack-custom" })],
	["an invalid generation", freshItem, modelPlan({ generation: 0 })],
	["a missing issue artifact", { ...freshItem, artifacts: {} }, modelPlan({ issueNumber: 44 })],
]) {
	assert.equal(
		JSON.stringify(canonicalStackPlan(item, plan, undefined)),
		JSON.stringify(legacyCanonicalOneNodePlan(item, plan)),
		`${label} on an empty stack is byte-identical to the one-node derivation`,
	);
}

// A restack of the only stacked item derives against the stack without its own
// node — an empty stack again, so the replan too is byte-identical to today.
const soloStack = appendReservedNode(undefined, { workItemId: replanItem.id, nodeId: "root", branch: "app-harness-os/10/g2", parentBranch: "main", parentBaseSha: A, stackId: "stack-0f0e0d0c" }).stack;
assert.equal(
	JSON.stringify(canonicalStackPlan(replanItem, modelPlan(), soloStack)),
	JSON.stringify(legacyCanonicalOneNodePlan(replanItem, modelPlan())),
	"the only live item's restack still derives the one-node root plan",
);

// ==== canonicalStackPlan: a second node stacks on the pinned tip ====

const parentStack = pinStackNode(appendReservedNode(undefined, { workItemId: "item-parent", nodeId: "root", branch: "app-harness-os/10/g1", parentBranch: "main", parentBaseSha: A, stackId: "stack-parent1" }).stack, "item-parent", B).stack;
const childItem = { id: "11223344-5566-4788-89aa-bbccddeeff00", plan: null, artifacts: { issue: { number: 11, url: "https://github.com/callil/autonomous-live-chat/issues/11" } } };
const childPlan = canonicalStackPlan(childItem, modelPlan({ baseSha: C, issueNumber: 11 }), parentStack);
assert.equal(childPlan.nodeId, "n-11223344", "a dependent node is named from its item");
assert.equal(childPlan.parentBranch, "app-harness-os/10/g1", "the parent is the pinned tip's branch");
assert.equal(childPlan.parentBaseSha, B, "the parent base is the tip's pinned head");
assert.equal(childPlan.pullRequestBase, "app-harness-os/10/g1", "the pull request targets the parent branch");
assert.equal(childPlan.stackId, "stack-parent1", "every node shares the room's stack epoch");
assert.equal(childPlan.branch, "app-harness-os/11/g1", "the node branch stays canonical per issue and generation");
assert.equal(childPlan.baseSha, C, "the model's read of main passes through untouched");

const reservedParent = appendReservedNode(undefined, { workItemId: "item-parent", nodeId: "root", branch: "app-harness-os/10/g1", parentBranch: "main", parentBaseSha: A, stackId: "stack-parent1" }).stack;
assert.equal(canonicalStackPlan(childItem, modelPlan({ issueNumber: 11 }), reservedParent).parentBaseSha, null, "a reserved tip yields a null parent base the ledger's own validation refuses");

// ==== Room wiring: the record, the hooks, and the teaching errors ====

const demoWorker = await readFile(new URL("../../apps/demo/src/index.ts", import.meta.url), "utf8");
assert.match(demoWorker, /const ROOM_STACK_KEY = "ledger-room-stack"/u, "the room stack is one plain room-storage key");
assert.match(demoWorker, /canonicalStackPlan\(workItem, input\.command\.plan, roomStack\)/u, "the staged plan is canonicalized against the live room stack");
assert.match(demoWorker, /appendReservedNode\(truncated\.stack, \{ workItemId: updated\.id, nodeId: plan\.nodeId, branch: plan\.branch, parentBranch: plan\.parentBranch, parentBaseSha: plan\.parentBaseSha, stackId: plan\.stackId \}\)/u, "the accepted plan appends its reserved node inside the recordPlan transaction");
assert.match(demoWorker, /The room stack moved before this plan could commit/u, "a plan staged against a moved stack is refused with a teaching error");
assert.match(demoWorker, /pinStackNode\(normalizeRoomStack\(await txn\.get\(ROOM_STACK_KEY\)\), updated\.id, input\.headSha\)/u, "recordCandidate pins the node inside its own transaction");
assert.match(demoWorker, /private async truncateRoomStackFor\(workItemId: string\)/u, "the truncate hook is one room method used at every release transition");
assert.match(demoWorker, /if \(staleSurvivors\.length\) await this\.nudgeRestackSurvivor\(staleSurvivors\[0\]\);/u, "a replan's truncation nudges the lowest stale survivor");
assert.match(demoWorker, /The room stack tip is not pinned yet: the item below must record its candidate first\. Reply WAITING/u, "the tip-pinned admission conjunct refuses with a teaching error");
assert.match(demoWorker, /restackProblem/u, "a stale survivor's snapshot carries the restack fact");
assert.match(demoWorker, /Your parent was restacked and this node left the room stack\. Stage a revised plan \(revision \$\{item\.plan \? item\.plan\.revision \+ 1 : 1\}, next generation, fresh getMainSha baseSha\)/u, "the restack fact names the exact next revision");

// ==== Room wiring: retarget ingestion, the pop, and the backstops ====

assert.match(demoWorker, /if \(parsed\.fact\.kind === "merged"\) \{\n\t\t\tfor \(const workItemId of merged\.freshIds\) await this\.popRoomStackBottom\(workItemId, parsed\.fact\.mergeCommitSha\);/u, "the merged webhook fact pops the bottom node and advances the recorded base");
assert.match(demoWorker, /if \(parsed\.fact\.kind === "stack"\) \{\n\t\t\tfor \(const workItemId of merged\.freshIds\) await this\.markRoomStackRetargeted\(workItemId, parsed\.fact\.base\);/u, "the stack fact marks a retargeted survivor without touching its provenance");
assert.match(demoWorker, /private async popRoomStackBottom\(workItemId: string, mergeCommitSha: string\)/u);
assert.match(demoWorker, /if \(bottom\) await this\.nudgeRestackSurvivor\(bottom\.workItemId\);/u, "the new bottom item gets one sweep-class poke so it promotes promptly");
assert.match(demoWorker, /private async markRoomStackRetargeted\(workItemId: string, base: string\)/u);
assert.match(demoWorker, /if \(!node \|\| node\.parentBranch === base\) return;/u, "a stack fact whose base still names the recorded parent is a join or move, never a retarget");
assert.match(demoWorker, /private async reconcileStackBottom\(now: number\)/u, "the sweep reconciles a lost merged delivery for the stack bottom");
assert.match(demoWorker, /await this\.reconcileStackBottom\(now\);/u, "reconciliation runs on every sweep");
assert.match(demoWorker, /observeCandidatePullRequest\(\{ number: candidate!\.pullRequestNumber as number \}\)/u, "the backstop is one bounded bridge observation of the recorded candidate PR");
assert.match(demoWorker, /observed\.merged && typeof observed\.mergeCommitSha === "string"/u, "only an observed merge with its commit reconciles the pop");
assert.match(demoWorker, /async rebuildStack\(\)/u, "the nuke-and-rebuild lever parks stacked items and clears the record");
assert.match(demoWorker, /"\/api\/admin\/rebuild-stack"/u, "the lever rides the bearer-authed admin surface");
assert.match(demoWorker, /gh stack unstack/u, "the trusted server-side unstack is documented as an operator-side manual step, never executed by this worker");
assert.match(demoWorker, /const mergeTrainHold = stackNode && stackNode\.position > 1 && validation\?\.conclusion === "success"/u, "a green upper node holds instead of promoting");
assert.match(demoWorker, /stack: \{ position: stackNode\.position, size: stackNode\.size, expectedOrder: stackNode\.expectedOrder/u, "the snapshot carries the merge-train coordinates the loop supplies to the runner");

console.log("room stack: append/pin/truncate/pop transforms, one-node byte equivalence, and room wiring passed");
