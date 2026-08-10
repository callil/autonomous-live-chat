import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stampDataLoc } from "../src/stamp.js";
import { createSandbox, parseFragment, runScript } from "../../platform/test/support/dom.mjs";

/**
 * PRODUCT BOUNDARY CONTRACTS.
 *
 * What survives here is only what the app is NOT allowed to change: the
 * platform/product split, binding isolation, and data-loc stamping. Everything
 * about how the app looks, reads, and is laid out lives in room-boot.test.mjs
 * as behaviour, or nowhere at all.
 *
 * WHAT WAS REMOVED, AND WHY (this file was the source of failure mode B).
 * PR #269 added assertions pinning exact prose, exact CSS values, and one-line
 * formatting of the implementation:
 *
 *   - `assert.match(html, /<p>Chat with the room, or use Target, Comment/)`
 *   - `assert.match(html, /<span class="room-meta">shape this app together<\/span>/)`
 *   - `assert.match(css, /grid-template-columns: 1\.75rem/)`
 *   - `assert.match(client, /hash = Math\.imul\(hash, 16777619\)/)`
 *   - `assert.match(client, /avatar\.style\.color = color; avatar\.setAttribute\(…\)/)`
 *
 * Those parked legitimate agent work TWICE. In an autonomous pipeline a brittle
 * test does not annoy a developer — it rejects a user's real request and
 * reports it as a failure. An agent asked to reword a heading, restyle a
 * message, or reformat a line MUST be able to, and copy, colour, and spacing
 * are exactly what the product surface exists to let agents change.
 *
 * The one real invariant hiding in that set — that a speaker is visually
 * identifiable and consistently so — is now tested as behaviour (same name in,
 * same colour out; different names, different colours) with no pinned constant.
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

test("every element an agent could be asked to change carries a data-loc anchor", () => {
	// Anchoring is how a request ("change THIS") reaches the right source line.
	// This asserts the PROPERTY over the whole page rather than naming elements:
	// it keeps holding as the app is rewritten, and it catches a stamper that
	// silently stops covering some tag.
	const stamped = stampDataLoc(html, "product/src/ui/room.html");
	const unstamped = parseFragment(stamped)
		.flatMap((node) => node.descendants())
		.filter((element) => !["HTML", "HEAD", "META", "TITLE", "LINK", "SCRIPT", "STYLE", "#TEXT"].includes(element.tagName))
		.filter((element) => !element.hasAttribute("data-loc"));
	assert.deepEqual(unstamped.map((element) => element.tagName), [], "every visible element must be anchorable");

	// And the anchors point at real lines in this file.
	const lines = html.split("\n").length;
	for (const match of stamped.matchAll(/data-loc="product\/src\/ui\/room\.html:(\d+)"/gu)) {
		const line = Number(match[1]);
		assert.ok(line >= 1 && line <= lines, `data-loc line ${line} is outside the file`);
	}
});

/**
 * The platform/product split. The harness surface — authoring tools, build
 * queue, activity feed, provenance — is served by the PLATFORM into a closed
 * shadow root. It must not exist in product source at all: that is what makes
 * it impossible for an agent change to this app to break or falsify the status
 * surface reporting on that very change.
 */
test("the app owns no harness chrome and speaks no harness protocol", () => {
	// These assert on CODE, not prose: each pattern is a protocol literal that
	// only real harness rendering would contain. The app is free to restyle and
	// reword everything it does own.
	assert.doesNotMatch(client, /"request:(?:target|comment|draw)"|`request:\$\{/u, "request envelopes belong to the overlay");
	assert.doesNotMatch(client, /"feed:update"|"feed:history"|"request:ack"/u, "feed rendering belongs to the overlay");
	assert.doesNotMatch(client, /domSnapshot:|dataLoc:|drawingPoints:/u, "annotation capture belongs to the overlay");
	assert.doesNotMatch(client, /classif/iu, "the app renders conversation and never classifies intent");
});

test("a speaker is identified consistently, without pinning how", async () => {
	// The invariant restored by #269 that IS real: the same person reads the
	// same way everywhere, and two different people are told apart. The hash
	// function, the colour space, the markup and the CSS are all the app's to
	// change — pinning `Math.imul(hash, 16777619)` was pinning an implementation.
	async function renderAuthors(authors) {
		const harness = createSandbox({ html });
		runScript(client, harness.sandbox);
		harness.fetches.at(-1).respond({ ok: true, json: async () => ({ id: "s1", name: "Ada" }) });
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		harness.sockets[0].emit("open", {});
		authors.forEach((author, index) => harness.sockets[0].deliver({ type: "chat:message", seq: index + 1, author, text: "hi", at: 1_700_000_000_000 }));
		// Whatever element carries the colour, and whichever property it uses.
		return harness.document.getElementById("messages").children.map((row) =>
			row.descendants().map((element) => element.style.getPropertyValue("color") || element.style.color).filter(Boolean).join("|"),
		);
	}

	const [first, second, third] = await renderAuthors(["Ada", "Grace", "Ada"]);
	assert.ok(first, "a speaker is given some visual identity");
	assert.equal(first, third, "the same speaker reads the same way every time");
	assert.notEqual(first, second, "two different speakers are told apart");

	// And it is stable across page loads, so a person looks the same to everyone.
	const [reloaded] = await renderAuthors(["Ada"]);
	assert.equal(reloaded, first, "identity is derived from the name, not from session order");
});

test("the error boundary and version stamp the platform depends on are present", () => {
	// Integration points with the frozen platform: the fallback target the page
	// bails to, and the SHA the reconciler observes to call a deploy live.
	assert.match(html, /<meta name="ahp-fallback"/u);
	assert.match(html, /<meta name="ahp-version" content="__DEPLOY_SHA__">/u, "the placeholder the deploy replaces");
	assert.match(client, /window\.__ahpBooted = true/u, "the client stands the error boundary down");
	assert.match(worker, /Response\.redirect\(new URL\("\/fallback", env\.PLATFORM_ORIGIN\)/u);
});

test("the product worker is binding-isolated and proxies the overlay to the platform", () => {
	assert.doesNotMatch(wrangler, /durable_objects|kv_namespaces|d1_databases|r2_buckets|queues|ROOM_DO|RUNNER/u);
	assert.match(wrangler, /"service": "app-harness-platform"\s*\}/u);
	assert.doesNotMatch(wrangler, /"entrypoint"/u);
	assert.match(worker, /new URL\(url\.pathname \+ url\.search, env\.PLATFORM_ORIGIN\)/u);
	assert.match(worker, /env\.PLATFORM\.fetch\(/u);
	assert.match(worker, /\/overlay\.js/u, "the overlay is proxied to the frozen platform, never served from product source");
	assert.match(worker, /\/version/u);
	assert.match(worker, /DEPLOY_SHA/u);
});
