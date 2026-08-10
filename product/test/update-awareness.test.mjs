import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSandbox, parseFragment, runScript } from "../../platform/test/support/dom.mjs";

/**
 * UPDATE AWARENESS — converted from grep to behaviour.
 *
 * This file used to be eight `assert.match` calls against the inline boot
 * script, pinning its exact source text down to `{ cache: 'no-store' }` and
 * `function () { location.reload(); }`. That asserted the implementation's
 * formatting, not the behaviour: reformatting the script would have failed it
 * while a version check that never fired would have passed.
 *
 * What actually matters: a room whose page is older than the live deploy must
 * find out and offer the user an explicit reload — never reload underneath
 * them, because a draft in the composer is worth more than being current.
 */

const html = await readFile(new URL("../src/ui/room.html", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

const LOADED_SHA = "a".repeat(40);
const NEWER_SHA = "b".repeat(40);

/** Boot the page's inline head script with a known loaded revision. */
function bootPage(loadedSha = LOADED_SHA) {
	const harness = createSandbox({ html: html.replace("__DEPLOY_SHA__", loadedSha) });
	const inline = /<script>([\s\S]*?)<\/script>/u.exec(html);
	assert.ok(inline, "the page carries its boot script inline so it runs before anything can fail");
	runScript(inline[1], harness.sandbox);
	harness.sandbox.dispatchEvent({ type: "DOMContentLoaded" });
	return harness;
}

/** Resolve the /version probe the page issues on load. */
async function answerVersion(harness, sha) {
	const probe = harness.fetches.at(-1);
	assert.ok(probe, "the page must ask the deployment what revision is live");
	assert.match(probe.url, /\/version/u);
	probe.respond({ ok: true, json: async () => ({ sha }) });
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	return probe;
}

test("the page notices it is older than the live deploy and offers an update", async () => {
	const harness = bootPage();
	const notice = harness.document.getElementById("app-update");
	assert.ok(notice, "there must be somewhere to surface the offer");
	assert.equal(notice.hidden, true, "nothing is announced before the check runs");

	await answerVersion(harness, NEWER_SHA);
	assert.equal(notice.hidden, false, "a newer deploy must be surfaced to the user");
});

test("a page already on the live revision says nothing", async () => {
	const harness = bootPage();
	await answerVersion(harness, LOADED_SHA);
	assert.equal(harness.document.getElementById("app-update").hidden, true, "no news is no notice");
});

test("the update is the user's choice: the page never reloads itself", async () => {
	// Silently reloading would discard whatever the user was typing. The offer
	// is a control they press.
	let reloads = 0;
	const harness = bootPage();
	harness.sandbox.location.reload = () => {
		reloads += 1;
	};
	await answerVersion(harness, NEWER_SHA);
	assert.equal(reloads, 0, "detecting a new version must not reload the page");

	harness.document.getElementById("app-update-button").dispatchEvent({ type: "click" });
	assert.equal(reloads, 1, "pressing the control reloads");
});

test("the check re-runs when the tab comes back, so a long-open room catches up", async () => {
	const harness = bootPage();
	await answerVersion(harness, LOADED_SHA);
	const before = harness.fetches.length;
	harness.sandbox.document.hidden = false;
	harness.sandbox.document.dispatchEvent({ type: "visibilitychange" });
	assert.ok(harness.fetches.length > before, "returning to the tab re-checks the deployed revision");
	await answerVersion(harness, NEWER_SHA);
	assert.equal(harness.document.getElementById("app-update").hidden, false);
});

test("a garbage or unreachable /version never breaks the page or shows a false alarm", async () => {
	for (const response of [
		{ ok: true, json: async () => ({ sha: "not-a-sha" }) },
		{ ok: true, json: async () => ({}) },
		{ ok: false, status: 500, json: async () => ({}) },
	]) {
		const harness = bootPage();
		const probe = harness.fetches.at(-1);
		assert.doesNotThrow(() => probe.respond(response));
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(harness.document.getElementById("app-update").hidden, true, "only a valid, different revision is worth announcing");
		assert.deepEqual(harness.consoleErrors, [], "a version check is best-effort and must never surface as an error");
	}
});

test("the error boundary bails to the platform fallback only when the app never boots", () => {
	// The boundary is the reason a broken product deploy degrades to a working
	// minimal UI instead of a blank page.
	let replaced = null;
	const harness = createSandbox({ html: html.replace("__DEPLOY_SHA__", LOADED_SHA) });
	harness.sandbox.location.replace = (target) => {
		replaced = target;
	};
	runScript(/<script>([\s\S]*?)<\/script>/u.exec(html)[1], harness.sandbox);

	// The client never booted: the timeout must bail out to the fallback.
	harness.flushTimers();
	assert.match(String(replaced), /\/fallback/u, "a room that never boots falls back to the frozen UI");

	// And when the client DOES boot, the boundary stands down.
	replaced = null;
	const booted = createSandbox({ html: html.replace("__DEPLOY_SHA__", LOADED_SHA) });
	booted.sandbox.location.replace = (target) => {
		replaced = target;
	};
	runScript(/<script>([\s\S]*?)<\/script>/u.exec(html)[1], booted.sandbox);
	booted.sandbox.window.__ahpBooted = true;
	booted.flushTimers();
	assert.equal(replaced, null, "a healthy room is never sent to the fallback");
});

test("the deployed revision is stamped server-side, so the page can compare at all", () => {
	// The one genuine source coupling: the worker must substitute a real SHA for
	// the placeholder, or every page believes it is current forever.
	assert.ok(parseFragment(html).length > 0, "the page parses");
	assert.match(html, /<meta name="ahp-version" content="__DEPLOY_SHA__">/u, "the placeholder the deploy replaces");
	assert.match(worker, /__DEPLOY_SHA__/u, "the worker replaces the placeholder at serve time");
	assert.match(worker, /DEPLOY_SHA/u, "the SHA comes from the deploy, not from source");
});
