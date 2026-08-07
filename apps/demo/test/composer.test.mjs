import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AUTHORING_ENVELOPE_POLICY } from "../../../packages/contracts/index.js";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const clientScript = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];

assert.ok(clientScript, "the browser client script is present");
assert.doesNotThrow(() => new Function(clientScript), "the browser client script parses");

assert.doesNotMatch(html, /maxlength=/u);
assert.doesNotMatch(html, /message-count/u);
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
assert.match(worker, /LEDGER_MIGRATION_KEY/u);
assert.match(worker, /DELIVERY_POLICY\.historyPageBytes/u);
assert.match(worker, /class LedgerService extends WorkerEntrypoint/u);
assert.match(worker, /createLedgerWorkItem/u);
assert.match(worker, /queueOperatorWake/u);
assert.match(worker, /putWakeInTransaction/u, "state and durable wake outbox are committed together");
assert.match(worker, /this\.ctx\.restore\(\{ type: "operator-note", workItemId: wake\.workItemId \}\)/u, "the OS can durably store and later invoke its response target");
assert.match(worker, /messageKey: `ledger-event:\$\{wake\.id\}:v\$\{wake\.version\}`/u, "each ledger revision creates one independently idempotent operator turn");
assert.doesNotMatch(worker, /chatGatewayRpcTarget: new OperatorNoteTarget/u, "ephemeral RPC targets never cross the persistent OS gateway");
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
