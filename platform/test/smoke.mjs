/**
 * SMOKE — the only layer that tests what is actually SERVED.
 *
 * Layers 1 and 2 run against the working tree. They cannot see a deploy that
 * did not happen, a worker binding that is not wired, a stale asset, or a
 * platform and product that disagree about what revision is live. That gap is
 * how a green pipeline coexisted with a broken room, twice.
 *
 * This runs AFTER a deploy, against the real origin, and its failure means the
 * live site is broken right now.
 *
 * HONEST LIMITATION: there is no headless browser here on purpose — adding
 * Chromium to this repo costs more install time in CI than the checks are
 * worth, and the boot layer already executes both client scripts every run.
 * So this does the HTTP + fetch-the-real-assets + execute-them subset:
 *
 *   - it fetches the deployed HTML and BOTH deployed scripts (the room client
 *     and the platform's overlay) and EXECUTES them against the DOM harness,
 *     so a shipped script that throws on load fails here;
 *   - it hit-tests the send control geometrically via elementFromPoint;
 *   - it creates a real session against the live API.
 *
 * What it therefore does NOT cover: real CSS layout and paint, real stacking
 * and z-index, and real browser event dispatch. A control mispositioned purely
 * by CSS would still pass. That is a known hole, recorded in docs/testing.md
 * rather than papered over.
 *
 * Usage: npm run smoke [-- --url <origin>] [--sha <expected>]
 */

import assert from "node:assert/strict";
import { createSandbox, runScript } from "./support/dom.mjs";

const DEFAULT_ORIGIN = "https://app-harness-product.coda-a.workers.dev";
const TIMEOUT_MS = 15_000;
const BUDGET_MS = 60_000;
// How long a just-finished deploy is allowed to still be reaching every edge.
const PROPAGATION_WAIT_MS = 30_000;

function argument(name, fallback = null) {
	const index = process.argv.indexOf(`--${name}`);
	if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
	return fallback;
}

const origin = (argument("url", process.env.SMOKE_URL || DEFAULT_ORIGIN)).replace(/\/$/u, "");
const expectedSha = argument("sha", process.env.SMOKE_SHA || null);

const started = Date.now();
const results = [];

async function check(name, run) {
	const at = Date.now();
	try {
		await run();
		results.push({ name, ok: true, ms: Date.now() - at });
	} catch (error) {
		results.push({ name, ok: false, ms: Date.now() - at, error: error?.message ?? String(error) });
	}
}

/** Fetch with a hard timeout, so a hanging origin fails loudly instead of stalling CI. */
async function get(path, init = {}) {
	const response = await fetch(`${origin}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
	return response;
}

let html = "";
let clientSource = "";
let overlaySource = "";
let liveSha = "";

await check("the room page is served", async () => {
	const response = await get("/");
	assert.equal(response.status, 200, `GET / returned ${response.status}`);
	html = await response.text();
	assert.ok(html.length > 0, "the page is empty");
	assert.match(html, /<html/iu, "the origin did not return an HTML document");
});

/** Read the revision the origin is currently serving. */
async function readLiveSha() {
	const response = await get("/version");
	assert.equal(response.status, 200, `GET /version returned ${response.status}`);
	const body = await response.json();
	assert.match(String(body.sha), /^[0-9a-f]{40}$/u, `/version served a malformed sha: ${JSON.stringify(body)}`);
	return body.sha;
}

await check("/version reports a real deployed revision", async () => {
	liveSha = await readLiveSha();
});

await check("the deployed revision matches the merge under test", async () => {
	// Skipped locally; in CI this is the assertion that proves the deploy that
	// just ran is the one being smoked, rather than a stale worker.
	if (!expectedSha) {
		results.push({ name: "  (no --sha given; revision match not asserted)", ok: true, ms: 0, note: true });
		return;
	}

	// A Workers deploy does not flip every edge colo at the same instant: during
	// propagation successive requests can legitimately be answered by the old
	// and the new revision. A single sample therefore proves nothing, and
	// asserting on one produced exactly that false alarm — the deploy was fine
	// and the smoke job went red. Poll until the expected revision is the answer
	// we get, and only call it stale if it never becomes so.
	const deadline = Date.now() + PROPAGATION_WAIT_MS;
	let observed = liveSha;
	while (observed !== expectedSha && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 3000));
		observed = await readLiveSha();
	}
	assert.equal(observed, expectedSha, `live revision ${observed} is not the expected ${expectedSha} after ${PROPAGATION_WAIT_MS}ms`);

	// Re-read the page and assets from the settled revision so every check below
	// describes one consistent deployment rather than a mix of two.
	if (observed !== liveSha) {
		liveSha = observed;
		html = await (await get("/")).text();
	}
});

await check("the page is stamped with a real deployed revision", async () => {
	// The invariant is that the deploy SUBSTITUTED a revision at all — without
	// it the room can never notice it is stale. Which of two revisions the page
	// carries mid-propagation is not a defect, so this deliberately does not
	// pin it to the /version sample taken a moment earlier.
	const stamp = /<meta name="ahp-version" content="([^"]*)">/u.exec(html);
	assert.ok(stamp, "the page carries no version stamp, so the room can never notice it is stale");
	assert.notEqual(stamp[1], "__DEPLOY_SHA__", "the deploy did not substitute the revision placeholder");
	assert.match(stamp[1], /^[0-9a-f]{40}$/u, `the page is stamped with something that is not a revision: ${stamp[1]}`);
});

await check("the room client asset is served and executes without throwing", async () => {
	const source = /<script src="([^"]*room\.client\.js)"/u.exec(html);
	assert.ok(source, "the page does not reference a room client");
	const response = await get(source[1]);
	assert.equal(response.status, 200, `the room client asset returned ${response.status}`);
	clientSource = await response.text();
	assert.ok(clientSource.length > 0, "the room client asset is empty");

	const harness = createSandbox({ html, location: { origin, host: new URL(origin).host } });
	runScript(clientSource, harness.sandbox);
	assert.deepEqual(harness.consoleErrors, [], `the deployed room client logged errors: ${harness.consoleErrors.join("; ")}`);
	assert.equal(harness.sandbox.window.__ahpBooted, true, "the deployed room client never finished booting, so every visitor is sent to /fallback");
});

await check("the platform overlay asset is served and executes without throwing", async () => {
	// The exact outage: the overlay threw on load, the transport never started,
	// and the room was inert while every test in the repo passed.
	assert.match(html, /<script src="\/overlay\.js"/u, "the page does not embed the platform overlay");
	const response = await get("/overlay.js");
	assert.equal(response.status, 200, `/overlay.js returned ${response.status}`);
	overlaySource = await response.text();
	assert.ok(overlaySource.length > 0, "/overlay.js is empty");

	const harness = createSandbox({ scriptDataset: { room: "main" }, location: { origin, host: new URL(origin).host } });
	runScript(overlaySource, harness.sandbox);
	assert.deepEqual(harness.consoleErrors, [], `the deployed overlay logged errors: ${harness.consoleErrors.join("; ")}`);
	assert.ok(harness.body.children.length > 0, "the deployed overlay mounted nothing");
	assert.equal(harness.fetches.length, 1, "the deployed overlay never started its transport");
	assert.match(harness.fetches[0].url, /\/api\/session/u);
});

await check("the send control exists in the served page and is hit-testable", async () => {
	const harness = createSandbox({ html, location: { origin, host: new URL(origin).host } });
	runScript(clientSource, harness.sandbox);
	const send = harness.document.getElementById("send");
	assert.ok(send, "the served page has no send control");
	assert.equal(send.disabled, false, "the send control is disabled in the served page");
	// Geometric hit-test: give it a box and confirm a click on it lands on it.
	send.setRect({ left: 1180, top: 660, width: 80, height: 40 });
	assert.equal(harness.document.elementFromPoint(1220, 680), send, "a click on the send control does not reach it");
});

await check("a session can be created against the live API", async () => {
	const response = await get("/api/session", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: `smoke-${Date.now()}` }),
	});
	const body = await response.text();
	assert.ok(response.status === 200 || response.status === 201, `POST /api/session returned ${response.status}: ${body.slice(0, 200)}`);
	const identity = JSON.parse(body);
	assert.ok(identity && typeof identity.id === "string" && identity.id.length, "the live API issued no session identity");
	assert.ok(response.headers.get("set-cookie"), "the live API issued no session cookie, so the room socket will refuse the upgrade");
});

await check("the frozen fallback UI the error boundary points at is reachable", async () => {
	// The error boundary sends visitors here when the app fails to boot; if it
	// is broken, a bad product deploy is a blank page instead of a degraded one.
	// The product worker rewrites this meta to the PLATFORM's absolute URL, so
	// follow whatever the served page actually points at rather than assuming
	// the path is local — /fallback on the product origin is correctly a 404.
	const meta = /<meta name="ahp-fallback" content="([^"]*)">/u.exec(html);
	assert.ok(meta, "the served page carries no fallback target");
	const target = new URL(meta[1], origin).toString();
	const response = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
	assert.equal(response.status, 200, `the fallback UI at ${target} returned ${response.status}`);
	assert.match(await response.text(), /<html/iu, "the fallback target did not serve a page");
});

const elapsed = Date.now() - started;
const failures = results.filter((result) => !result.ok);

console.log(`\nSmoke — ${origin}${expectedSha ? ` @ ${expectedSha.slice(0, 8)}` : ""}\n`);
for (const result of results) {
	if (result.note) {
		console.log(`  ~ ${result.name}`);
		continue;
	}
	console.log(`  ${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.ok ? "" : `\n        ${result.error}`}  (${result.ms}ms)`);
}
const checks = results.filter((result) => !result.note);
console.log(`\n${checks.filter((result) => result.ok).length}/${checks.length} checks passed in ${elapsed}ms (live revision ${liveSha || "unknown"})\n`);

if (elapsed > BUDGET_MS) console.warn(`WARNING: smoke took ${elapsed}ms, over its ${BUDGET_MS}ms budget.`);

if (failures.length) {
	console.error(`SMOKE FAILED: the deployment at ${origin} is broken right now.\n`);
	process.exit(1);
}
