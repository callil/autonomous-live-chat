import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AUTHORING_ENVELOPE_POLICY } from "../../../packages/contracts/index.js";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const clientScript = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];

assert.ok(clientScript, "the browser client script is present");
assert.doesNotThrow(() => new Function(clientScript), "the browser client script parses");
assert.match(clientScript, /function renderMessageSnapshot\(messages\) \{ messagesEl\.replaceChildren\(\); rendered\.clear\(\);/u, "a reconnect snapshot replaces retired chat state instead of merging it");
assert.match(clientScript, /event\.type === 'chat:snapshot'\) \{ renderMessageSnapshot\(event\.messages\)/u, "every authoritative chat snapshot uses replacement semantics");

assert.doesNotMatch(html, /maxlength=/u);
assert.doesNotMatch(html, /message-count/u);
assert.match(html, /<span class="room-title"[^>]*>Live Main room<\/span>/u);
assert.match(html, /<h1>Shape this app together<\/h1>/u);
const browserSafeTextPolicy = html.match(/TARGET_SAFE_TEXT_CHARACTERS = (\d+)/u);
assert.equal(Number(browserSafeTextPolicy?.[1]), AUTHORING_ENVELOPE_POLICY.safeTextCharacters, "the no-build demo mirrors the shared privacy envelope exactly");
assert.doesNotMatch(worker, /MAX_(?:MESSAGE_LENGTH|REQUEST_LENGTH|STORED_MESSAGES|STORED_ANNOTATIONS|STORED_WORK_ITEMS)/u);
assert.match(worker, /DELIVERY_POLICY\.historyRecordsPerPage/u);
assert.match(worker, /type: "chat:history"/u);
assert.match(worker, /type: "harness:annotation:added"/u);
assert.match(worker, /type: "harness:work-item"/u);
assert.match(worker, /storageDeleteBatches/u);
assert.match(worker, /fitsDurableRecord/u);
assert.match(worker, /DELIVERY_POLICY\.historyPageBytes/u);
assert.match(worker, /class LedgerService extends WorkerEntrypoint/u);
assert.match(worker, /this\.env\.CHAT_ROOM\.getByName\("main"\)/u, "private ledger RPC keeps the original durable authority and action-ID namespace");
assert.match(worker, /env\.CHAT_ROOM\.getByName\(room\)\.fetch\(request\)/u, "the public room and private ledger share one durable authority");
assert.match(worker, /await this\.ctx\.storage\.deleteAlarm\(\)/u, "retired experimental wakes cannot survive the paused reset");
assert.match(worker, /createLedgerWorkItem/u);
assert.match(worker, /queueOperatorWake/u);
assert.match(worker, /putWakeInTransaction/u, "state and durable wake outbox are committed together");
assert.match(worker, /const wakeKey = `ledger-event:\$\{inFlight\.id\}:v\$\{inFlight\.version\}:t\$\{inFlight\.turn\}`/u, "each delivered or recovery turn keeps its independently idempotent wake key");
assert.match(worker, /submitWake\(\{\n\t\t\t\t\tworkItemId: inFlight\.workItemId,\n\t\t\t\t\tversion: inFlight\.version,\n\t\t\t\t\tturn: inFlight\.turn,\n\t\t\t\t\twakeKey,\n\t\t\t\t\tstate: operatorWakeState\(stateItem, stateActions, stateFacts\),\n\t\t\t\t\}\)/u, "every wake is one structured RPC embedding the authoritative ledger snapshot");
assert.doesNotMatch(worker, /submitExternalMessage|chatGatewayRpcTarget|OPERATOR_INSTRUCTION|OPERATOR_GADGET_KEY|OPERATOR_CHAT_KEY/u, "the demo no longer speaks the Cloudflare OS chat protocol");
assert.doesNotMatch(worker, /RpcTarget|RpcStub|this\.ctx\.restore\(|\[restore\]/u, "no persistent RPC stub lifecycle survives the transport swap");
assert.match(worker, /recordOperatorNote\(input: \{ workItemId: string; expectedVersion: number; turn: number; response: OperatorResponse \}\)/u, "the operator settles its turn through a plain LedgerService RPC");
assert.match(worker, /\/api\/runner\/complete/u, "the isolated runner reports completion by push");
assert.match(worker, /ingestExternalFact/u, "pushed external facts share one verified ingest entry point");
assert.match(worker, /item\.activeImplementation\?\.runId !== parsed\.runId/u, "the per-run ledger identifier is the callback's bearer credential");
assert.match(worker, /beginOperatorWakeDelivery/u, "an accepted operator turn uses the tested durable response barrier");
assert.match(worker, /settleOperatorWakeRecord/u, "stale callbacks and no-progress responses use the tested wake contract");
assert.match(worker, /const OPERATOR_TURN_DELIVERY_ATTEMPTS = 3/u, "missing callbacks have a bounded recovery budget");
assert.match(worker, /await this\.ctx\.storage\.deleteAlarm\(\)/u, "paused mode removes its alarm instead of spinning in the background");
assert.match(worker, /executionToken/u, "operator action completion is fenced to its current execution lease");
assert.match(worker, /listOperatorActions/u, "a later operator turn can reconcile prior staged or applied actions");
assert.match(worker, /harness:work-item:history/u, "each durable work item exposes paginated public activity");
assert.match(worker, /if \(room !== "main"\)/u, "the only configured ledger room cannot create orphaned side ledgers");
assert.doesNotMatch(worker, /CoordinatorJob|CoordinatorEffect|GITHUB_AUTOMATION_TOKEN|AUTONOMY_CALLBACK_SECRET|\/api\/autonomy\/callback|api\.github\.com/u);
assert.match(worker, /AUTHORING_ENVELOPE_POLICY\.safeTextCharacters/u);
assert.doesNotMatch(worker, /broadcast\(\{ type: "harness:annotations", annotations: await/u);
assert.match(html, /id="load-earlier-messages"/u);
assert.match(html, /id="load-earlier-activity"/u);
assert.match(html, /Load earlier updates/u, "the UI can retrieve a work item's older status events");

// Guard the established keyboard contract while changing composer behavior.
assert.match(html, /event\.key === 'Enter' && !event\.shiftKey/);
assert.match(html, /event\.preventDefault\(\); form\.requestSubmit\(\);/);

console.log("uncapped composer and durable record contracts passed");
