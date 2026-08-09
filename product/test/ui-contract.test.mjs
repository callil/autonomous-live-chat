import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stampDataLoc } from "../src/stamp.js";

/**
 * The product UI contract. Dependency-free on purpose: this file is ALSO the
 * sandbox runner's local fast-fail gate, executed in a fresh checkout with
 * plain node before any candidate is pushed. CI remains the merge authority.
 */

const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const wrangler = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const html = await readFile(new URL("../src/ui/room.html", import.meta.url), "utf8");
const client = await readFile(new URL("../src/ui/room.client.js", import.meta.url), "utf8");

test("data-loc stamping is line-accurate, deterministic, and idempotent", () => {
	const source = ["<html>", "<body>", '  <div class="x">', '    <p data-loc="keep:1">hi</p>', "  </div>", "</body>", "</html>"].join("\n");
	const stamped = stampDataLoc(source, "product/src/ui/room.html");
	assert.match(stamped, /<body data-loc="product\/src\/ui\/room\.html:2">/u);
	assert.match(stamped, /<div class="x" data-loc="product\/src\/ui\/room\.html:3">/u);
	assert.match(stamped, /<p data-loc="keep:1">/u, "an existing data-loc is never overwritten");
	assert.doesNotMatch(stamped, /<html data-loc/u, "structural chrome is not stamped");
	assert.equal(stampDataLoc(source, "product/src/ui/room.html"), stamped, "deterministic");
});

test("stamping never rewrites script or style bodies", () => {
	const source = ["<script>", "if (a < b) { run(); }", "</script>", "<span>ok</span>"].join("\n");
	const stamped = stampDataLoc(source, "f.html");
	assert.match(stamped, /if \(a < b\) \{ run\(\); \}/u, "script bodies pass through verbatim");
	assert.match(stamped, /<span data-loc="f\.html:4">/u);
});

test("the real room page stamps cleanly and every rail landmark survives", () => {
	const stamped = stampDataLoc(html, "product/src/ui/room.html");
	for (const anchor of ['id="messages"', 'id="feed-items"', 'id="queue-chips"', 'id="tool-target"', 'id="tool-comment"', 'id="tool-draw"', 'id="request-composer"', 'id="join-form"']) {
		assert.ok(stamped.includes(anchor), `${anchor} must exist in the room shell`);
	}
	assert.match(stamped, /<header class="topbar" data-loc="product\/src\/ui\/room\.html:\d+">/u, "the room header carries its stamp");
});

test("the error boundary falls back to the platform's frozen minimal UI", () => {
	assert.match(html, /<meta name="ahp-fallback" content="\/fallback">/u);
	assert.match(html, /location\.replace\(target\)/u, "a broken bundle redirects to the fallback");
	assert.match(client, /window\.__ahpBooted = true/u, "a healthy boot clears the boundary");
	assert.match(worker, /Response\.redirect\(new URL\("\/fallback", env\.PLATFORM_ORIGIN\)/u, "a failed stamp serves the fallback from the worker too");
});

test("the sole request trigger is an explicit Target/Comment/Draw envelope with the captured anchors", () => {
	assert.match(client, /type: `request:\$\{kind\}`/u, "requests go out as request:<kind> envelopes");
	assert.match(client, /dataLoc: element\.dataset\.loc/u, "the build-stamped data-loc ref anchors every envelope");
	assert.match(client, /domSnapshot: element\.outerHTML/u, "the captured DOM rides verbatim");
	assert.match(client, /drawingPoints: pendingDraw\.points/u, "draw envelopes carry their points");
	assert.match(client, /clientSubmissionId/u);
	assert.match(client, /request:cancel/u, "the cancel window is one click");
	assert.doesNotMatch(client, /classif/iu, "no per-utterance classification — chat is chat");
});

test("the client speaks only the platform's room protocol, same-origin", () => {
	assert.match(client, /\/api\/rooms\/main/u);
	assert.match(client, /fetch\("\/api\/session"/u, "identity comes from the platform's signed session");
	assert.doesNotMatch(client, /https:\/\/app-harness-platform/u, "no cross-origin calls: everything rides the product proxy");
});

test("the product worker is binding-isolated: zero DOs, zero services, only the proxy seam", () => {
	assert.doesNotMatch(wrangler, /durable_objects|"services"|kv_namespaces|d1_databases|r2_buckets|queues/u, "ZERO ledger access by construction");
	assert.match(worker, /new URL\(url\.pathname \+ url\.search, env\.PLATFORM_ORIGIN\)/u, "the /api proxy is verbatim");
	assert.match(worker, /\/version/u);
	assert.match(worker, /DEPLOY_SHA/u, "the deployed SHA is served for observed deploys");
});
