import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stampDataLoc } from "../src/stamp.js";

const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const wrangler = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const html = await readFile(new URL("../src/ui/room.html", import.meta.url), "utf8");
const client = await readFile(new URL("../src/ui/room.client.js", import.meta.url), "utf8");
const css = await readFile(new URL("../src/ui/room.css", import.meta.url), "utf8");

test("data-loc stamping is line-accurate, deterministic, and idempotent", () => {
	const source = ["<html>", "<body>", '  <div class="x">', '    <p data-loc="keep:1">hi</p>', "  </div>", "</body>", "</html>"].join("\n");
	const stamped = stampDataLoc(source, "product/src/ui/room.html");
	assert.match(stamped, /<body data-loc="product\/src\/ui\/room\.html:2">/u);
	assert.match(stamped, /<div class="x" data-loc="product\/src\/ui\/room\.html:3">/u);
	assert.match(stamped, /<p data-loc="keep:1">/u);
	assert.doesNotMatch(stamped, /<html data-loc/u);
	assert.equal(stampDataLoc(source, "product/src/ui/room.html"), stamped);
});

test("stamping never rewrites script or style bodies", () => {
	const source = ["<script>", "if (a < b) { run(); }", "</script>", "<span>ok</span>"].join("\n");
	const stamped = stampDataLoc(source, "f.html");
	assert.match(stamped, /if \(a < b\) \{ run\(\); \}/u);
	assert.match(stamped, /<span data-loc="f\.html:4">/u);
});

test("the real room page stamps cleanly and every harness landmark survives", () => {
	const stamped = stampDataLoc(html, "product/src/ui/room.html");
	for (const anchor of ['id="messages"', 'id="feed-items"', 'id="queue-chips"', 'id="tool-target"', 'id="tool-comment"', 'id="tool-draw"', 'id="request-composer"', 'id="join-form"']) assert.ok(stamped.includes(anchor), `${anchor} must exist in the room shell`);
	assert.match(stamped, /<header class="topbar" data-loc="product\/src\/ui\/room\.html:\d+">/u);
});

test("the queue wraps the app and the toolbar reports active build sessions immediately", () => {
	assert.ok(html.indexOf('id="queue-section"') < html.indexOf('<main class="columns">'), "the queue is above app content");
	assert.match(html, /id="active-session-count">0<\/span> active/u);
	assert.match(client, /optimisticRequests \+= 1; updateActiveSessions\(\)/u, "submit increments the visible count before the acknowledgement");
	assert.match(client, /queueStatusDot\.classList\.toggle\("is-busy", count > 0\)/u);
	assert.match(css, /\.queue-status-dot\.is-busy[^}]*animation:\s*queue-pulse/u);
});

test("the error boundary falls back to the platform's frozen minimal UI", () => {
	assert.match(html, /<meta name="ahp-fallback" content="\/fallback">/u);
	assert.match(html, /location\.replace\(target\)/u);
	assert.match(client, /window\.__ahpBooted = true/u);
	assert.match(worker, /Response\.redirect\(new URL\("\/fallback", env\.PLATFORM_ORIGIN\)/u);
});

test("the sole request trigger is an explicit Target/Comment/Draw envelope with the captured anchors", () => {
	assert.match(client, /type: `request:\$\{kind\}`/u);
	assert.match(client, /dataLoc: element\.dataset\.loc/u);
	assert.match(client, /domSnapshot: element\.outerHTML/u);
	assert.match(client, /drawingPoints: pendingDraw\.points/u);
	assert.match(client, /clientSubmissionId/u);
	assert.match(client, /request:cancel/u);
	assert.doesNotMatch(client, /classif/iu);
});

test("the annotation composer opens by its drop point, stays on-screen, and supports shortcut submit", () => {
	assert.match(client, /positionRequestComposer\(anchor\)/u);
	assert.match(client, /event\.clientX, y: event\.clientY/u);
	assert.match(client, /innerWidth - rect\.width - COMPOSER_GUTTER/u);
	assert.match(client, /innerHeight - rect\.height - COMPOSER_GUTTER/u);
	assert.match(client, /event\.metaKey \|\| event\.ctrlKey/u);
	assert.match(client, /requestComposer\.requestSubmit\(\)/u);
	assert.match(html, />Submit<\/button>/u);
});

test("the join flow completes: hidden always wins the cascade and failures are surfaced", () => {
	assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/u);
	assert.match(html, /id="join" hidden/u);
	assert.match(html, /id="request-composer" hidden/u);
	assert.match(client, /joinError\.textContent = \(await response\.text\(\)\) \|\| `Join failed \(\$\{response\.status\}\)\.`/u);
	assert.match(client, /joinError\.textContent = "Could not reach the room\. Try again\."/u);
	assert.match(client, /joinButton\.disabled = true/u);
});

test("the client speaks only the platform's room protocol, same-origin", () => {
	assert.match(client, /\/api\/rooms\/main/u);
	assert.match(client, /fetch\("\/api\/session"/u);
	assert.doesNotMatch(client, /https:\/\/app-harness-platform/u);
});

test("the product worker is binding-isolated: zero DOs, only the platform's public fetch seam", () => {
	assert.doesNotMatch(wrangler, /durable_objects|kv_namespaces|d1_databases|r2_buckets|queues|ROOM_DO|RUNNER/u);
	assert.match(wrangler, /"service": "app-harness-platform"\s*\}/u);
	assert.doesNotMatch(wrangler, /"entrypoint"/u);
	assert.match(worker, /new URL\(url\.pathname \+ url\.search, env\.PLATFORM_ORIGIN\)/u);
	assert.match(worker, /env\.PLATFORM\.fetch\(/u);
	assert.match(worker, /\/version/u);
	assert.match(worker, /DEPLOY_SHA/u);
});
