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
const client = await readFile(new URL("../src/ui/room.client.js", import.meta.url), "utf8");

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

/**
 * PUSH beats poll: the platform records deploy-observed at the exact moment
 * /version serves the new revision and broadcasts it over the room WebSocket.
 * The banner must appear the INSTANT that fact arrives — and never before it,
 * because a banner during edge propagation tells the user to refresh into the
 * OLD code, which is worse than a late banner.
 */

/** Boot the full page: inline head script + room client, socket connected, load-time poll settled as current. */
async function bootPageWithClient() {
	const harness = bootPage();
	const versionProbe = harness.fetches.find((request) => /\/version/u.test(request.url));
	versionProbe.respond({ ok: true, json: async () => ({ sha: LOADED_SHA }) });
	runScript(client, harness.sandbox);
	const session = harness.fetches.at(-1);
	assert.match(session.url, /\/api\/session/u);
	session.respond({ ok: true, json: async () => ({ id: "s1", name: "Ada" }) });
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	const socket = harness.sockets.at(-1);
	assert.ok(socket, "the room client connects its socket");
	socket.emit("open", {});
	return { harness, socket };
}

test("a deploy-observed frame renders the update banner instantly, no poll required", async () => {
	const { harness, socket } = await bootPageWithClient();
	const notice = harness.document.getElementById("app-update");
	assert.equal(notice.hidden, true);

	const fetchesBefore = harness.fetches.length;
	socket.deliver({
		type: "feed:update",
		queue: [],
		items: [{ seq: 9, at: Date.now() + 1_000, kind: "deploy-observed", text: "Deploy observed serving.", refs: { sha: NEWER_SHA } }],
	});
	assert.equal(notice.hidden, false, "the banner appears the instant the deploy-observed fact arrives");
	assert.equal(harness.fetches.length, fetchesBefore, "push needs no /version round-trip");
});

test("deploy-requested alone never shows the banner", async () => {
	// Between the merge and the observed deploy, a refresh serves the OLD
	// code. The banner before deploy-observed would be actively harmful.
	const { harness, socket } = await bootPageWithClient();
	socket.deliver({
		type: "feed:update",
		queue: [],
		items: [{ seq: 9, at: Date.now() + 1_000, kind: "deploy-requested", text: "Deploy requested.", refs: { sha: NEWER_SHA } }],
	});
	assert.equal(harness.document.getElementById("app-update").hidden, true, "a requested deploy is not a served deploy");
});

test("historical deploy-observed facts replayed in a snapshot are not news", async () => {
	// Snapshots and updates carry recent history; a deploy observed BEFORE
	// this page loaded produced this page (or an older one the load-time poll
	// already covers) and must not fire the push path.
	const { harness, socket } = await bootPageWithClient();
	socket.deliver({
		type: "room:snapshot",
		chat: [],
		feed: { queue: [], items: [{ seq: 3, at: Date.now() - 60_000, kind: "deploy-observed", text: "Deploy observed serving.", refs: { sha: NEWER_SHA } }] },
	});
	assert.equal(harness.document.getElementById("app-update").hidden, true, "old facts are history, not an update offer");
});

test("a reconnect re-checks the deployed revision as the poll fallback", async () => {
	// Push cannot cover a deploy that happened while the socket was down, so
	// reconnecting runs the /version check once.
	const { harness, socket } = await bootPageWithClient();

	socket.close();
	const sessionRecheck = harness.fetches.at(-1);
	assert.match(sessionRecheck.url, /\/api\/session/u, "the client validates its session before reconnecting");
	sessionRecheck.respond({ ok: true, json: async () => ({ id: "s1", name: "Ada" }) });
	await Promise.resolve();
	await Promise.resolve();
	harness.flushTimers(2_000);
	const reopened = harness.sockets.at(-1);
	assert.notEqual(reopened, socket, "a new socket is opened");
	const fetchesBefore = harness.fetches.length;
	reopened.emit("open", {});
	assert.ok(harness.fetches.length > fetchesBefore, "reconnecting triggers the fallback version check");
	await answerVersion(harness, NEWER_SHA);
	assert.equal(harness.document.getElementById("app-update").hidden, false, "a deploy missed while offline is still surfaced");
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
