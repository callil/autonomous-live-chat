import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AUTHORING_ENVELOPE_POLICY } from "../../../packages/contracts/index.js";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const entry = await readFile(new URL("../src/entry.ts", import.meta.url), "utf8");
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
assert.match(entry, /SHIPPED_LIVE_FOOTER = '<span class="shipped-live">Shipped live by App Harness\.<\/span>'/u, "the composer has the requested live-shipping footer");
assert.match(entry, /\.replace\(COMPOSER_HINT, `\$\{COMPOSER_HINT\}\$\{SHIPPED_LIVE_FOOTER\}`\)/u, "the footer is rendered directly beneath the composer");
assert.match(entry, /activity\.replaceChildren\(count\);/u, "the compact activity control removes its original Activity copy");
assert.doesNotMatch(entry, /active-status-label|icons\.activity/u, "the compact activity control has no Active copy or activity icon");
assert.match(entry, /count\.textContent = String\(active\.length\);/u, "the active count is displayed without an issue-number prefix");
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
assert.match(worker, /pokeOperator/u, "every relevant ledger event fires one fire-and-forget poke at the operator");
assert.match(worker, /submitWake\(\{ workItemId: item\.id \}\)/u, "a poke carries no state; the operator reads a fresh snapshot at turn start");
assert.match(worker, /snapshotWorkItem/u, "the authoritative snapshot is a loop-owned ledger read, not wake payload");
assert.match(worker, /SWEEP_INTERVAL_MS/u, "one slow safety-net sweep re-pokes any live item");
assert.match(worker, /OPERATOR_POKE_CAP/u, "a lifetime poke budget parks a non-converging item for review");
assert.doesNotMatch(worker, /submitExternalMessage|chatGatewayRpcTarget|OPERATOR_INSTRUCTION|OPERATOR_GADGET_KEY|OPERATOR_CHAT_KEY/u, "the demo no longer speaks the Cloudflare OS chat protocol");
assert.doesNotMatch(worker, /RpcTarget|RpcStub|this\.ctx\.restore\(|\[restore\]/u, "no persistent RPC stub lifecycle survives the transport swap");
assert.doesNotMatch(worker, /recordOperatorNote|WakeRecord|beginOperatorWakeDelivery|settleOperatorWakeRecord|requireLease|leaseId|resumeAt/u, "no wake-record or lease machinery survives in the ledger");
assert.match(worker, /\/api\/runner\/complete/u, "the isolated runner reports completion by push");
assert.match(worker, /ingestExternalFact/u, "pushed external facts share one verified ingest entry point");
assert.match(worker, /item\.activeImplementation\?\.runId !== parsed\.runId/u, "the per-run ledger identifier is the callback's bearer credential");
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
