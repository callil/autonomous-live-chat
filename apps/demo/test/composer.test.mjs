import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

assert.doesNotMatch(html, /maxlength=/u);
assert.doesNotMatch(html, /message-count/u);
assert.doesNotMatch(worker, /MAX_(?:MESSAGE_LENGTH|REQUEST_LENGTH|STORED_MESSAGES|STORED_ANNOTATIONS|STORED_WORK_ITEMS)/u);
assert.match(worker, /storage\.put\(this\.messageKey\(message\.id\), message\)/u);
assert.match(worker, /storage\.list<ChatMessage>\(\{ prefix: MESSAGE_PREFIX \}\)/u);
assert.match(worker, /storage\.list<HarnessAnnotation>\(\{ prefix: ANNOTATION_PREFIX \}\)/u);

// Guard the established keyboard contract while changing composer behavior.
assert.match(html, /event\.key === 'Enter' && !event\.shiftKey/);
assert.match(html, /event\.preventDefault\(\); form\.requestSubmit\(\);/);

console.log("uncapped composer and durable record contracts passed");
