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
assert.match(worker, /ORDER_INDEX_MIGRATION_KEY/u);
assert.match(worker, /DELIVERY_POLICY\.historyPageBytes/u);
assert.match(worker, /return this\.ctx\.storage\.get<WorkflowRecord>\(WORKFLOW_KEY\)/u);
assert.match(worker, /AUTHORING_ENVELOPE_POLICY\.safeTextCharacters/u);
assert.doesNotMatch(worker, /broadcast\(\{ type: "harness:annotations", annotations: await/u);
assert.match(html, /id="load-earlier-messages"/u);
assert.match(html, /id="load-earlier-activity"/u);

// Guard the established keyboard contract while changing composer behavior.
assert.match(html, /event\.key === 'Enter' && !event\.shiftKey/);
assert.match(html, /event\.preventDefault\(\); form\.requestSubmit\(\);/);

console.log("uncapped composer and durable record contracts passed");
