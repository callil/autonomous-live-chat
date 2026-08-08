import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
	clearCreditsExhausted,
	grantImplementSlot,
	IMPLEMENT_SLOTS,
	implementQueuePosition,
	isCreditsExhaustedClassification,
	normalizeAdmissionState,
	recordCreditsExhausted,
	releaseImplementSlot,
} from "../../packages/contracts/admission.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [demoWorker, operatorWorker, operatorModel, operatorExecute, operatorContracts, runnerWorker, agentEntrypoint] = await Promise.all([
	read("../../apps/demo/src/index.ts"),
	read("../workers/operator/src/index.ts"),
	read("../workers/operator/src/model.ts"),
	read("../workers/operator/src/execute.ts"),
	read("../workers/operator/src/contracts.ts"),
	read("../workers/native-git-runner/src/index.ts"),
	read("../workers/native-git-runner/agent-entrypoint.mjs"),
]);

// ==== Admission control: slot grant / reject / release + queue position ====

assert.equal(IMPLEMENT_SLOTS, 3, "the merge-train gate admits three concurrent implementation-to-merge items");

let state = normalizeAdmissionState(undefined);
assert.deepEqual(state, { holders: [], queue: [], announced: {} }, "an empty room has an empty admission record");

for (const id of ["item-a", "item-b", "item-c"]) {
	const grant = grantImplementSlot(state, id);
	assert.equal(grant.granted, true, `${id} is admitted while slots are free`);
	state = grant.state;
}
assert.deepEqual(state.holders, ["item-a", "item-b", "item-c"]);

const regrant = grantImplementSlot(state, "item-b");
assert.equal(regrant.granted, true, "a current holder re-grants idempotently");
assert.deepEqual(regrant.state.holders, state.holders, "an idempotent re-grant never double-counts the slot");
state = regrant.state;

const fourth = grantImplementSlot(state, "item-d");
assert.equal(fourth.granted, false, "the fourth concurrent item is refused");
assert.equal(fourth.position, 1, "the first refused item is first in the queue");
assert.equal(fourth.ahead, 0, "nothing is queued ahead of the first refused item");
state = fourth.state;

const fifth = grantImplementSlot(state, "item-e");
assert.equal(fifth.granted, false);
assert.equal(fifth.position, 2);
assert.equal(fifth.ahead, 1, "the second refused item sees one item ahead");
state = fifth.state;

const requeue = grantImplementSlot(state, "item-d");
assert.equal(requeue.granted, false);
assert.equal(requeue.position, 1, "a repeated refusal keeps the item's arrival-order position");
assert.deepEqual(requeue.state.queue, ["item-d", "item-e"], "a repeated refusal never duplicates the queue entry");
state = requeue.state;

assert.equal(implementQueuePosition(state, "item-d"), 1);
assert.equal(implementQueuePosition(state, "item-e"), 2);
assert.equal(implementQueuePosition(state, "item-a"), null, "a slot holder has no queue position");

const releaseHolder = releaseImplementSlot(state, "item-b");
assert.equal(releaseHolder.released, true, "a slot holder's release frees the slot");
assert.deepEqual(releaseHolder.state.holders, ["item-a", "item-c"]);
state = releaseHolder.state;

const afterRelease = grantImplementSlot(state, "item-d");
assert.equal(afterRelease.granted, true, "a queued item is admitted once a slot frees");
assert.deepEqual(afterRelease.state.queue, ["item-e"], "a granted item leaves the queue");
assert.equal(implementQueuePosition(afterRelease.state, "item-e"), 1, "positions shift forward when the queue advances");
state = afterRelease.state;

const releaseQueued = releaseImplementSlot(state, "item-e");
assert.equal(releaseQueued.released, true, "a queued item that ends while waiting releases its queue place");
assert.deepEqual(releaseQueued.state.queue, [], "the terminal queued item leaves the queue");
const releaseNothing = releaseImplementSlot(releaseQueued.state, "item-z");
assert.equal(releaseNothing.released, false, "releasing an item that holds nothing reports released: false");

// The announced map only ever tracks currently queued items.
const announcedState = normalizeAdmissionState({ holders: ["item-a"], queue: ["item-b"], announced: { "item-b": 1, "item-gone": 4, "item-a": 2 } });
assert.deepEqual(announcedState.announced, { "item-b": 1 }, "announced positions are pruned to the live queue");

// ==== Credits health fact: set / skip / clear ====

assert.equal(isCreditsExhaustedClassification("agent-credits-exhausted"), true, "the coding agent's credit classification is recognized");
assert.equal(isCreditsExhaustedClassification("model-credits-exhausted"), true, "the operator loop's credit note is recognized");
assert.equal(isCreditsExhaustedClassification("agent-model-unavailable"), false, "transient unavailability is never treated as a credit outage");
assert.equal(isCreditsExhaustedClassification(undefined), false);

const set = recordCreditsExhausted(undefined, 1_000);
assert.deepEqual(set, { health: { creditsExhausted: true, at: 1_000 }, changed: true }, "the first report records the outage");
const skip = recordCreditsExhausted(set.health, 2_000);
assert.equal(skip.changed, false, "a repeated report changes nothing, so the announcement is spoken once");
assert.equal(skip.health.at, 1_000, "a repeated report keeps the original outage timestamp");
const clear = clearCreditsExhausted(skip.health);
assert.deepEqual(clear, { health: null, changed: true }, "recovery clears the fact");
assert.equal(clearCreditsExhausted(undefined).changed, false, "clearing a clean room changes nothing");

// ==== Ledger wiring: admission gate ====

assert.match(demoWorker, /const ADMISSION_STATE_KEY = "ledger-implement-admission"/u, "the admission record is one plain room-storage key");
assert.match(demoWorker, /if \(current\.activeImplementation && Date\.now\(\) - current\.activeImplementation\.startedAt < STALLED_IMPLEMENTATION_MS\) return \{ implementAlreadyLive: true as const \};\n\t\t\t\tif \(!stackTipPinned\(normalizeRoomStack\(await txn\.get\(ROOM_STACK_KEY\)\), current\.id\)\) return \{ stackTipUnpinned: true as const \};\n\t\t\t\tconst grant = grantImplementSlot\(await txn\.get\(ADMISSION_STATE_KEY\), current\.id\);/u, "the slot grant is transactional with the staged implement action, refuses a duplicate live run, and carries the room-stack tip-pinned conjunct");
assert.match(demoWorker, /if \(input\.command\.kind === "plan"\) \{\n\t\t\t\tconst effective = truncateStack\(normalizeRoomStack\(await txn\.get\(ROOM_STACK_KEY\)\), current\.id\)\.stack;\n\t\t\t\tif \(!stackTipPinned\(effective, current\.id\)\) return \{ stackTipUnpinned: true as const \};/u, "a dependent plan under an unpinned tip is refused at stage time as a WAITING teaching error, never burned against the rejection budget at apply");
assert.match(demoWorker, /An isolated implementation run is already live for this item and inside its execution deadline\./u, "the duplicate-run refusal is a WAITING teaching error");
assert.match(demoWorker, /await this\.reconcileCandidateValidation\(now\);/u, "the sweep reconciles lost validation evidence for stuck candidates");
assert.match(demoWorker, /deliveryId: `reconcile:validation:\$\{item\.id\}:\$\{validation\.runId\}`/u, "reconciled validation evidence rides the same deduplicated fact path the webhook uses");
assert.match(demoWorker, /Reconciled the candidate's recorded head to the live pull request head/u, "a stale recorded candidate head is repaired from the bounded PR observation");
assert.match(demoWorker, /if \(!grant\.granted\) return \{ implementQueuedAhead: grant\.ahead \};/u, "a refused grant commits the queue registration before the stage is refused");
assert.match(demoWorker, /All \$\{IMPLEMENT_SLOTS\} implementation slots are busy: \$\{action\.implementQueuedAhead\} item\(s\) are queued ahead/u, "the refusal is a teaching error that names the queue");
assert.match(demoWorker, /Reply WAITING; the ledger re-pokes this item when a slot frees\./u, "the teaching error tells the model the honest next step");
assert.match(demoWorker, /operatorSnapshot\(item, actions, facts, implementQueuePosition\(admission, item\.id\), isStaleStackNode\(roomStack, item\.id\), stackNodeContext\(roomStack, item\.id\)\)/u, "the turn snapshot carries the item's queue position, its room-stack staleness, and its merge-train coordinates");
assert.match(demoWorker, /implementQueue: \{ position: queuePosition/u, "a queued snapshot names position and the WAITING instruction");
assert.match(demoWorker, /if \(persisted\.phase === "retryable" \|\| TERMINAL_PHASES\.has\(persisted\.phase\)\) \{\n\t\t\tawait this\.releaseImplementSlotFor\(persisted\.id\);\n\t\t\tawait this\.truncateRoomStackFor\(persisted\.id\);\n\t\t\}/u, "retryable and terminal transitions release the slot and truncate the room stack together");
assert.match(demoWorker, /parsed\.fact\.kind === "merged" \|\| \(parsed\.fact\.kind === "promotion" && parsed\.fact\.conclusion === "success"\)/u, "a merged fact or a successful promotion run releases the slot");
assert.match(demoWorker, /await this\.releaseImplementSlotFor\(item\.id\);\n\t\t\t\tawait this\.truncateRoomStackFor\(item\.id\);\n\t\t\t\tpurged \+= 1;/u, "a purged item cannot keep holding a slot, a queue place, or a room-stack node");
assert.match(demoWorker, /private async releaseImplementSlotFor\(workItemId: string\)/u);
assert.match(demoWorker, /releaseImplementSlot\(await txn\.get\(ADMISSION_STATE_KEY\), workItemId\)/u, "release is transactional too");
assert.match(demoWorker, /private async announceImplementQueue\(\)/u, "queue positions are published to the public feed");
assert.match(demoWorker, /if \(state\.announced\[id\] === position\) continue;/u, "position lines are throttled: only a changed position speaks");
assert.match(demoWorker, /Waiting for an implementation slot/u, "the feed line is honest about why the item waits");
assert.match(demoWorker, /this\.pokeOperator\(item, "sweep"\);\n\t\t\}\n\t\}\n\n\t\/\*\*\n\t \* Public honesty/u, "a freed slot nudges the queue head without consuming its lifetime poke cap");

// ==== Ledger wiring: credit outage set / skip / clear ====

assert.match(demoWorker, /const SYSTEM_HEALTH_KEY = "system-health"/u, "the credit outage is one room-level system fact");
assert.match(demoWorker, /isCreditsExhaustedClassification\(parsed\.fact\.classification\)/u, "a credential-verified runner artifact can record the outage");
assert.match(demoWorker, /normalizeOperatorNoteInput\(input\)/u, "the operator worker's health note rides the same ingest entry point");
assert.match(demoWorker, /raw\.source !== "operator"/u, "the note is a declared source, distinct from runner and github");
assert.match(demoWorker, /private async recordModelCreditsExhausted\(\)/u);
assert.match(demoWorker, /Model credits are exhausted; work is paused until the balance is restored\./u, "the outage is announced in the public chat");
assert.match(demoWorker, /if \(outcome\.changed\) await this\.systemChat\(/u, "the announcement is spoken exactly once per outage");
assert.match(demoWorker, /const health = await this\.ctx\.storage\.get<CreditsHealth>\(SYSTEM_HEALTH_KEY\);\n\t\tif \(health\?\.creditsExhausted\) \{/u, "the sweep checks the outage fact before poking anything");
assert.match(demoWorker, /probeModel\(\)\.catch\(/u, "each sweep spends one minimal recovery probe through the operator worker");
assert.match(demoWorker, /if \(!probe\.ok\) return;/u, "while the outage stands, the sweep skips every poke");
assert.match(demoWorker, /await this\.ctx\.storage\.delete\(SYSTEM_HEALTH_KEY\);\n\t\t\t\tawait this\.systemChat\("Model credits are restored; paused work is resuming\."\);/u, "the first successful probe clears the fact and announces recovery");
assert.match(demoWorker, /probeModel\(\): Promise<\{ ok: boolean; status\?: number \}>/u, "the probe is part of the typed operator transport");

// ==== Operator worker: distinct credit parking and the health note ====

assert.match(operatorModel, /modelErrorCode/u, "the model transport classifies the 429 body");
assert.match(operatorModel, /status === 429 && \/insufficient_quota\/u\.test\(detail\)/u, "insufficient_quota is detected distinctly from ordinary 429 overload");
assert.match(operatorModel, /get creditsExhausted\(\): boolean/u, "the error carries a non-retryable credit flag");
assert.match(operatorModel, /export async function probeModel/u, "the 1-call recovery probe lives beside the transport it exercises");
assert.match(operatorWorker, /&& !error\.creditsExhausted\)/u, "exhausted credits are never retried inside the turn");
assert.match(operatorWorker, /PARKED:model-credits-exhausted/u, "the credit outage parks under its own code, not generic unavailability");
assert.match(operatorWorker, /ingestExternalFact\(\{ source: "operator", workItemId: turn\.workItemId, note: "model-credits-exhausted" \}\)/u, "the loop reports the outage to the ledger before parking");
assert.match(operatorWorker, /async probeModel\(\)/u, "OperatorGateway exposes the recovery probe to the ledger sweep");
assert.match(operatorContracts, /ingestExternalFact\(input: unknown\): Promise<\{ accepted: boolean \}>/u, "the ledger contract carries the fact-ingest surface");

// ==== Runner agent: agent-credits-exhausted is distinct and non-retryable ====

assert.match(agentEntrypoint, /insufficient_quota/u, "the coding agent inspects the 429 body");
assert.match(agentEntrypoint, /throw classified\("credits", "agent-credits-exhausted"\);/u, "quota exhaustion classifies distinctly and is not retryable");
assert.match(agentEntrypoint, /throw classified\("upstream", "agent-model-unavailable", true\);/u, "ordinary overload stays retryable");

// ==== Capacity backpressure: the loop waits, the model never hot-retries ====

assert.match(operatorExecute, /classification === "sandbox-capacity-exhausted"/u, "the implement executor inspects the startRun receipt");
assert.match(operatorExecute, /throw new Error\("sandbox-capacity-exhausted: every sandbox slot is busy; the run was not started\."\);/u, "a full pool never records an implementation start");
assert.ok(operatorExecute.indexOf("sandbox-capacity-exhausted") < operatorExecute.indexOf("startImplementation"), "the capacity check precedes the ledger implementation start");
assert.match(operatorWorker, /const CAPACITY_REPOKE_MS = 90_000;/u, "a capacity wait re-pokes after 90 seconds");
assert.match(operatorWorker, /pending\.name === "stageImplementation" && typeof failure === "string" && failure\.includes\("sandbox-capacity-exhausted"\)/u, "the loop, not the model, recognizes capacity exhaustion");
assert.match(operatorWorker, /return this\.finish\(turn, CAPACITY_WAIT_OUTCOME\);/u, "the turn ends WAITING instead of returning the error to the model");
assert.match(operatorWorker, /outcome === CAPACITY_WAIT_OUTCOME \? CAPACITY_REPOKE_MS : WAITING_REPOKE_MS/u, "the capacity wait uses its own longer alarm");

// ==== Stale pool-size comments are gone ====

assert.doesNotMatch(runnerWorker, /max_instances is 2|max_instances to 2/u, "no comment still claims the sandbox pool is two instances");

console.log("load readiness: admission slots, credit-outage health, and capacity backpressure contracts passed");
