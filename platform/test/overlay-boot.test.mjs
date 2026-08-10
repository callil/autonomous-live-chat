import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyPointerEvents, createSandbox, runScript } from "./support/dom.mjs";

/**
 * OVERLAY BOOT — the layer that kills the false green.
 *
 * Every overlay test in this repo used to be a source grep. All of them passed
 * while the shipped overlay threw `ReferenceError: Cannot access 'dockEl'
 * before initialization` on page load: the IIFE died before the transport
 * started, the WebSocket never opened, and the live room was inert for users.
 *
 * These tests EXECUTE the real overlay against a DOM stub and assert on what
 * happens. They are invariants, not content: nothing here pins a label, a
 * colour, a size, or a string of prose. The overlay may be redesigned freely
 * and these still hold — but it cannot ship broken.
 */

const overlay = await readFile(new URL("../src/overlay/overlay.client.js", import.meta.url), "utf8");

/** Boot the overlay the way a page does, and return everything worth asserting on. */
function bootOverlay({ withBody = true } = {}) {
	const harness = createSandbox({ scriptDataset: { room: "main", anchorMode: "data-loc" } });
	if (!withBody) harness.sandbox.document.body = null;
	runScript(overlay, harness.sandbox);
	const host = harness.body.children.at(-1) ?? null;
	return { ...harness, host, root: host?.closedShadowRoot ?? null };
}

test("the overlay script executes on load without throwing", () => {
	// The exact outage: a load-time throw. Nothing below can be trusted until
	// this holds, which is why it is asserted on its own.
	assert.doesNotThrow(() => bootOverlay(), "the overlay must not throw while loading");
	const { consoleErrors } = bootOverlay();
	assert.deepEqual(consoleErrors, [], "booting must not log errors");
});

test("the overlay mounts its surface into the page inside a closed shadow root", () => {
	const { host, root, sandbox } = bootOverlay();
	assert.ok(host, "the overlay must attach a host element to the document");
	assert.ok(root, "the surface must live in a shadow root");
	assert.equal(root.mode, "closed", "the app must not be able to reach in and restyle the surface");
	assert.equal(host.shadowRoot, null, "a closed root is not exposed to page script");
	// The host is pointer-transparent, so an app that knows nothing about the
	// overlay keeps every click that does not land on visible overlay chrome.
	assert.match(host.style.cssText, /pointer-events:\s*none/u);
	assert.ok(sandbox.window.__appHarnessOverlay, "the overlay marks itself mounted so a second tag is a no-op");
});

test("the overlay starts its transport: a session is fetched, then the room socket opens", async () => {
	const { fetches, sockets } = bootOverlay();
	// This is the assertion the grep suite could not make. During the outage the
	// script died before this line and no socket was ever created.
	assert.equal(fetches.length, 1, "the overlay asks for the existing session before connecting");
	assert.match(fetches[0].url, /\/api\/session/u);

	fetches[0].respond({ ok: true, json: async () => ({ id: "s1", name: "Ada" }) });
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(sockets.length, 1, "an authenticated overlay opens exactly one room socket");
	assert.match(sockets[0].url, /^wss:\/\//u, "the transport is a secure WebSocket");
	assert.match(sockets[0].url, /\/api\/rooms\/main/u, "it joins the room named by the script tag");
});

test("the overlay does not connect when there is no session, and retries instead of dying", async () => {
	const { fetches, sockets, timers } = bootOverlay();
	fetches[0].respond({ ok: false, status: 401, text: async () => "" });
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(sockets.length, 0, "an anonymous visitor gets no socket");
	assert.ok(timers.some((timer) => timer.ms > 0), "the overlay schedules a retry rather than giving up permanently");
});

test("the overlay survives a page whose body has not parsed yet", () => {
	// Scripts load in head on some pages; deferring the mount must not break it.
	const { sandbox, body } = bootOverlay({ withBody: false });
	sandbox.document.body = body;
	assert.doesNotThrow(() => sandbox.document.dispatchEvent({ type: "DOMContentLoaded" }), "the deferred mount must not throw");
	assert.ok(body.children.length > 0, "the surface mounts once the body exists");
});

test("the overlay's own controls exist and are reachable by a pointer", () => {
	const { root, host, sandbox } = bootOverlay();
	const css = root.innerHTML.slice(root.innerHTML.indexOf("<style>"), root.innerHTML.indexOf("</style>"));
	const surface = root.descendants();
	applyPointerEvents(css, surface);
	host.pointerEvents = "none";

	// The three authoring tools are the overlay's reason to exist. Their labels,
	// icons, and styling are free to change; their reachability is not.
	const dock = root.querySelector(".dock");
	assert.ok(dock, "the overlay renders a dock");
	const pill = root.querySelector(".pill");
	assert.ok(pill, "the dock shows an always-visible control");

	// Containers must never capture clicks they do not draw; leaf controls must.
	for (const selector of [".layer", ".dock", ".draw", ".hint"]) {
		const element = root.querySelector(selector);
		if (!element) continue;
		assert.equal(element.pointerEvents, "none", `${selector} is a container and must not swallow the app's clicks`);
	}
	for (const selector of [".pill", ".panel", ".composer"]) {
		const element = root.querySelector(selector);
		assert.ok(element, `${selector} must exist`);
		assert.equal(element.pointerEvents, "auto", `${selector} is a real control and must be clickable`);
	}
	assert.ok(sandbox, "sandbox constructed");
});

test("the overlay publishes the region it occupies, measured from real layout", () => {
	const { root, rootStyle, flushFrames } = bootOverlay();
	const dock = root.querySelector(".dock");
	assert.ok(dock, "the dock must exist to be measured");

	// A visible pill at the bottom-right of a 1280x720 viewport, and a hidden
	// panel that is WIDER — the panel must be ignored, or the app is pushed
	// around by chrome that is not on screen.
	const [visible, hidden] = [dock.children[0], dock.children[1]];
	assert.ok(visible && hidden, "the dock has both a visible control and a collapsible panel");
	visible.hidden = false;
	visible.setRect({ left: 1000, top: 660, width: 264, height: 44 });
	hidden.hidden = true;
	hidden.setRect({ left: 780, top: 300, width: 480, height: 400 });

	assert.equal(flushFrames(), 1, "mount schedules a measurement on the next frame");

	// 1280 - 1000 = 280 wide, 720 - 660 = 60 tall. Derived, never hardcoded on
	// either side: the app reads these variables and needs no knowledge of the
	// dock's size.
	assert.equal(rootStyle.getPropertyValue("--app-harness-dock-inset-right"), "280px");
	assert.equal(rootStyle.getPropertyValue("--app-harness-dock-inset-bottom"), "60px");
});

test("the overlay re-measures when its own layout changes", () => {
	const { root, rootStyle, flushFrames, observers } = bootOverlay();
	const dock = root.querySelector(".dock");
	const pill = dock.children[0];
	pill.hidden = false;
	pill.setRect({ left: 1100, top: 680, width: 164, height: 40 });
	flushFrames();
	assert.equal(rootStyle.getPropertyValue("--app-harness-dock-inset-right"), "180px");

	// Open the panel: the published region must grow, or the app's chrome ends
	// up underneath it.
	const panel = dock.children[1];
	panel.hidden = false;
	panel.setRect({ left: 800, top: 300, width: 464, height: 380 });
	assert.ok(observers.length > 0, "the overlay observes its own size");
	for (const observer of observers) observer.callback([]);
	assert.equal(rootStyle.getPropertyValue("--app-harness-dock-inset-right"), "480px");
});

test("a second overlay tag on the same page is a no-op, not a second surface", () => {
	const harness = createSandbox({ scriptDataset: { room: "main" } });
	runScript(overlay, harness.sandbox);
	const afterFirst = harness.body.children.length;
	runScript(overlay, harness.sandbox);
	assert.equal(harness.body.children.length, afterFirst, "the overlay mounts exactly once per page");
	assert.deepEqual(harness.consoleErrors, []);
});

test("the overlay ignores malformed server frames instead of dying on them", async () => {
	const { fetches, sockets, consoleErrors } = bootOverlay();
	fetches[0].respond({ ok: true, json: async () => ({ id: "s1", name: "Ada" }) });
	await Promise.resolve();
	await Promise.resolve();
	const socket = sockets[0];
	socket.emit("open", {});

	// A transport that throws on one bad frame takes the whole surface down with
	// it, which is the same class of outage as the load-time throw.
	assert.doesNotThrow(() => socket.emit("message", { data: "not json at all" }));
	assert.doesNotThrow(() => socket.deliver({ type: "totally:unknown" }));
	assert.doesNotThrow(() => socket.deliver({ type: "feed:update", queue: null, items: null }));
	assert.deepEqual(consoleErrors, [], "a malformed frame is ignored quietly, not logged as a crash");
});
