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
assert.match(worker, /this\.ctx\.restore\(\{ type: "operator-note", workItemId: inFlight\.workItemId, expectedVersion: inFlight\.version, turn: inFlight\.turn \}\)/u, "the OS can durably store and later invoke its response target");
assert.match(worker, /messageKey: `ledger-event:\$\{inFlight\.id\}:v\$\{inFlight\.version\}:t\$\{inFlight\.turn\}`/u, "each no-progress operator turn gets an independently idempotent message");
assert.match(worker, /const OPERATOR_CHAT_KEY = "operator-v3"/u, "the persistent operator chat was migrated after external messages began provisioning ambient capabilities");
assert.match(worker, /const OPERATOR_GADGET_KEY = "callil-autonomous-live-chat-v2"/u, "the persistent operator gadget cannot retain the legacy APP_HARNESS binding");
assert.match(worker, /gadgetKey: OPERATOR_GADGET_KEY/u, "every ledger wake reaches the clean persistent operator workspace");
assert.match(worker, /chatKey: OPERATOR_CHAT_KEY/u, "every ledger wake reaches the one persistent operator chat");
assert.doesNotMatch(worker, /gadgetKey: "callil-autonomous-live-chat"/u, "the legacy gadget binding cannot shadow the ambient operator capability");
assert.doesNotMatch(worker, /chatKey: "operator-main"/u, "the capability-frozen legacy operator chat is never reused");
assert.doesNotMatch(worker, /const OPERATOR_CHAT_KEY = "operator-v2"/u, "the pre-provisioning operator chat is never reused");
assert.doesNotMatch(worker, /chatGatewayRpcTarget: new OperatorNoteTarget/u, "ephemeral RPC targets never cross the persistent OS gateway");
assert.match(worker, /state: "in_flight"/u, "an accepted operator turn retains a durable response lease");
assert.match(worker, /wake\.version !== expectedVersion \|\| \(wake\.turn \?\? 1\) !== turn/u, "stale operator callbacks cannot regress the monotonic turn");
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
