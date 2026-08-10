import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyPointerEvents, createSandbox, runScript } from "./support/dom.mjs";

/**
 * OVERLAY BOOT — the layer that kills the false green.
 *
 * These tests EXECUTE the real overlay against a DOM stub and assert on what
 * happens. They are invariants, not content: nothing here pins a label, a
 * colour, a size, or a string of prose. The overlay may be redesigned freely
 * and these still hold — but it cannot ship broken.
 *
 * The invariants covered here, in order:
 *  - it boots, mounts a closed shadow root, and starts its transport
 *  - hit-testing discipline: containers pass clicks through, controls do not
 *  - the TRUE-OVERLAY contract: zero layout influence on the app, ever
 *  - the hover preview: armed pointing shows what will be targeted, excludes
 *    the overlay's own chrome, and rides the envelope on submit
 *  - the pipeline stays visibly active through verifying/deploying
 *  - keyboard layering (Escape) and focus return
 */

const overlay = await readFile(new URL("../src/overlay/overlay.client.js", import.meta.url), "utf8");

/** Boot the overlay the way a page does, and return everything worth asserting on. */
function bootOverlay({ withBody = true } = {}) {
	const harness = createSandbox({ scriptDataset: { room: "main", anchorMode: "data-loc" } });
	if (!withBody) harness.sandbox.document.body = null;
	runScript(overlay, harness.sandbox);
	// The host mounts on <html>, outside <body>, so framed mode's body
	// transform can never scale the overlay's own chrome.
	const host = harness.documentElement.children.find((child) => child.getAttribute?.("data-app-harness") === "overlay") ?? null;
	return { ...harness, host, root: host?.closedShadowRoot ?? null };
}

/** Connect the booted overlay's socket so requests can round-trip. */
async function connectOverlay(harness) {
	harness.fetches[0].respond({ ok: true, json: async () => ({ id: "s1", name: "Ada" }) });
	await Promise.resolve();
	await Promise.resolve();
	const socket = harness.sockets[0];
	socket.emit("open", {});
	return socket;
}

/** An app element with enough shape for hover, capture, and envelope building. */
function appElement(harness, { tag = "BUTTON", rect = { left: 100, top: 100, width: 120, height: 40 }, dataLoc = null } = {}) {
	const element = harness.document.createElement(tag);
	element.className = "checkout";
	element.textContent = "Buy now";
	element.outerHTML = `<${tag.toLowerCase()} class="checkout">Buy now</${tag.toLowerCase()}>`;
	if (dataLoc) element.setAttribute("data-loc", dataLoc);
	element.setRect(rect);
	element.pointerEvents = "auto";
	harness.body.append(element);
	return element;
}

test("the overlay script executes on load without throwing", () => {
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
	// Scripts load in head on some pages; the overlay mounts on <html>, which
	// always exists, so a missing body must not break the boot.
	const { host, consoleErrors } = bootOverlay({ withBody: false });
	assert.ok(host, "the surface mounts even before <body> parses");
	assert.deepEqual(consoleErrors, []);
});

test("the overlay's own controls exist and are reachable by a pointer; containers pass clicks through", () => {
	const { root, host } = bootOverlay();
	const css = root.innerHTML.slice(root.innerHTML.indexOf("<style>"), root.innerHTML.indexOf("</style>"));
	const surface = root.descendants();
	applyPointerEvents(css, surface);
	host.pointerEvents = "none";

	const dock = root.querySelector(".dock");
	assert.ok(dock, "the overlay renders a dock");
	const pill = root.querySelector(".pill");
	assert.ok(pill, "the dock shows an always-visible control");

	// Containers must never capture clicks they do not draw; leaf controls must.
	// The hover-preview lane in particular must be FULLY pointer-transparent —
	// it exists to show what is under the cursor and must never become it.
	for (const selector of [".layer", ".dock", ".draw", ".hint", ".hover-box", ".hover-chip", ".tip"]) {
		const element = root.querySelector(selector);
		if (!element) continue;
		assert.equal(element.pointerEvents, "none", `${selector} must not swallow the app's clicks`);
	}
	for (const selector of [".pill", ".panel", ".composer", ".handle"]) {
		const element = root.querySelector(selector);
		assert.ok(element, `${selector} must exist`);
		assert.equal(element.pointerEvents, "auto", `${selector} is a real control and must be clickable`);
	}
});

test("TRUE OVERLAY: mounting and opening the panel never touches the app's layout", () => {
	const harness = bootOverlay();
	const { root, rootStyle, sandbox } = harness;
	const app = appElement(harness, { rect: { left: 40, top: 600, width: 800, height: 60 } });
	const before = JSON.stringify(app.getBoundingClientRect());
	const bodyStyleBefore = JSON.stringify([...sandbox.document.body.style.properties.entries()]);

	// Open the panel — the overlay's largest piece of chrome.
	root.getElementById("status-toggle").dispatchEvent({ type: "click" });
	assert.equal(root.getElementById("panel").hidden, false, "the panel opens");

	// The app's geometry is untouched and no inset/padding contract exists:
	// the overlay publishes NOTHING for the app to consume.
	assert.equal(JSON.stringify(app.getBoundingClientRect()), before, "the app must not reflow around overlay chrome");
	for (const name of rootStyle.properties.keys()) {
		assert.doesNotMatch(name, /inset|padding|margin|width|height/u, `the overlay must not publish layout hints (${name})`);
	}
	// Framed mode may write PAINT-ONLY properties to the body (transform et
	// al) — never layout-affecting ones.
	for (const name of sandbox.document.body.style.properties.keys()) {
		assert.doesNotMatch(name, /padding|margin|width|height|inset|top|left|right|bottom|font|display|position/u, `framed mode must stay paint-only (${name})`);
	}

	// Close the panel: every inline property the overlay wrote is restored
	// verbatim, so the page is byte-identical to before.
	root.getElementById("status-toggle").dispatchEvent({ type: "click" });
	harness.flushTimers(500);
	assert.equal(JSON.stringify([...sandbox.document.body.style.properties.entries()]), bodyStyleBefore, "the app's inline styles are restored exactly on exit");
});

test("framed mode scales by transform while open and restores <html> exactly on exit", () => {
	const harness = bootOverlay();
	const { root, sandbox } = harness;
	const html = sandbox.document.documentElement;
	const htmlStyleBefore = JSON.stringify([...html.style.properties.entries()]);

	// Arm a tool: the harness is "open", the page is framed.
	root.getElementById("t-target").dispatchEvent({ type: "click" });
	assert.match(sandbox.document.body.style.getPropertyValue("transform"), /scale/u, "the page insets via transform, never layout");
	assert.ok(html.style.getPropertyValue("background").length > 0, "the revealed backdrop is painted behind the page");

	// Disarm: everything restores.
	sandbox.document.dispatchEvent({ type: "keydown", key: "Escape" });
	harness.flushTimers(500);
	assert.equal(JSON.stringify([...html.style.properties.entries()].filter(([name]) => name !== "cursor")), htmlStyleBefore, "the backdrop is removed verbatim on exit");
	assert.equal(sandbox.document.body.style.getPropertyValue("transform"), "", "the transform is removed on exit");
});

test("armed hovering previews the element under the cursor with its selector path", async () => {
	const harness = bootOverlay();
	const { root, sandbox } = harness;
	await connectOverlay(harness);
	const app = appElement(harness, { dataLoc: "src/ui/page.html:42:3" });

	root.getElementById("t-target").dispatchEvent({ type: "click" });
	sandbox.document.dispatchEvent({ type: "mousemove", clientX: 150, clientY: 120, target: app });

	const box = root.getElementById("hover-box");
	const chip = root.getElementById("hover-chip");
	assert.equal(box.hidden, false, "a highlight box appears over the hovered element");
	assert.equal(box.style.left, "100px", "the box tracks the element's box");
	assert.equal(box.style.top, "100px");
	assert.equal(box.style.width, "120px");
	assert.equal(box.style.height, "40px");
	assert.equal(chip.hidden, false, "a label chip identifies the element before any click");
	const chipText = `${root.getElementById("chip-path").textContent} ${root.getElementById("chip-name").textContent}`;
	assert.match(chipText, /checkout/u, "the chip carries the element's readable selector path");
	assert.match(chipText, /src\/ui\/page\.html:42:3/u, "the chip shows the data-loc so the user sees the exact source anchor");
});

test("the hover preview excludes the overlay's own chrome", async () => {
	const harness = bootOverlay();
	const { root, host, sandbox } = harness;
	await connectOverlay(harness);
	appElement(harness);

	root.getElementById("t-target").dispatchEvent({ type: "click" });
	// Moving over the overlay host (what elementFromPoint reports above our
	// chrome, since the root is closed) must never preview overlay chrome.
	sandbox.document.dispatchEvent({ type: "mousemove", clientX: 150, clientY: 120, target: host });
	assert.equal(root.getElementById("hover-box").hidden, true, "the overlay never highlights itself");
	assert.equal(root.getElementById("hover-chip").hidden, true);
});

test("clicking the previewed element opens the composer and the envelope carries the selector path", async () => {
	const harness = bootOverlay();
	const { root, sandbox } = harness;
	const socket = await connectOverlay(harness);
	const app = appElement(harness, { dataLoc: "src/ui/page.html:42:3" });

	root.getElementById("t-target").dispatchEvent({ type: "click" });
	sandbox.document.dispatchEvent({ type: "mousemove", clientX: 150, clientY: 120, target: app });
	sandbox.document.dispatchEvent({ type: "click", clientX: 150, clientY: 120, target: app });

	const composer = root.getElementById("composer");
	assert.equal(composer.hidden, false, "the composer opens on selection");
	assert.equal(app.getAttribute("data-app-harness-hilite"), "", "the selected element carries the visual marker");

	root.getElementById("input").value = "Make this bigger";
	composer.dispatchEvent({ type: "submit" });
	const frame = socket.sent.map((raw) => JSON.parse(raw)).find((message) => message.type === "request:target");
	assert.ok(frame, "submitting sends the request envelope");
	assert.equal(frame.annotation.dataLoc, "src/ui/page.html:42:3", "the data-loc anchor rides the envelope");
	assert.ok(typeof frame.annotation.selectorPath === "string" && frame.annotation.selectorPath.length > 0, "the readable selector path rides the envelope as a structural hint");
	assert.ok(frame.annotation.domSnapshot.length > 0, "the captured DOM rides verbatim");
});

test("an intent in verifying or deploying still renders as ACTIVE until its terminal fact", async () => {
	const harness = bootOverlay();
	const { root } = harness;
	const socket = await connectOverlay(harness);

	// The exact complaint: the count dropped to zero while a change was still
	// verifying/deploying, minutes before it was actually live.
	socket.deliver({ type: "feed:update", queue: [{ intentId: "intent-1", runId: "run-1", phase: "verifying", label: "verifying" }], items: [] });
	assert.match(root.getElementById("status-text").textContent, /^1 /u, "a verifying intent counts as active");

	socket.deliver({ type: "feed:update", queue: [{ intentId: "intent-1", runId: "run-1", phase: "deploying", label: "deploying" }], items: [] });
	assert.match(root.getElementById("status-text").textContent, /^1 /u, "a deploying intent counts as active");
	const rows = root.getElementById("queue").children;
	assert.equal(rows.length, 1, "the pipeline entry is visible in the queue panel");

	// Only the terminal fact empties the pipeline.
	socket.deliver({ type: "feed:update", queue: [], items: [] });
	assert.match(root.getElementById("status-text").textContent, /^0 /u, "the count returns to zero only when the pipeline is empty");
});

test("Escape peels one layer per press: composer, then mode, then panel", async () => {
	const harness = bootOverlay();
	const { root, sandbox } = harness;
	await connectOverlay(harness);
	const app = appElement(harness);

	// Stack the layers: panel open, then a selection flow that leaves the
	// composer open (arming a tool intentionally disarms while composing).
	root.getElementById("status-toggle").dispatchEvent({ type: "click" });
	root.getElementById("t-target").dispatchEvent({ type: "click" });
	sandbox.document.dispatchEvent({ type: "click", clientX: 150, clientY: 120, target: app });

	const composer = root.getElementById("composer");
	const panel = root.getElementById("panel");
	assert.equal(composer.hidden, false);
	assert.equal(panel.hidden, false);

	sandbox.document.dispatchEvent({ type: "keydown", key: "Escape" });
	assert.equal(composer.hidden, true, "first Escape closes the composer only");
	assert.equal(panel.hidden, false, "the panel survives that press");

	// Re-arm: the armed mode is now the innermost layer above the panel.
	root.getElementById("t-target").dispatchEvent({ type: "click" });
	assert.equal(root.getElementById("t-target").getAttribute("aria-pressed"), "true");

	sandbox.document.dispatchEvent({ type: "keydown", key: "Escape" });
	assert.equal(root.getElementById("t-target").getAttribute("aria-pressed"), "false", "next Escape disarms the mode");
	assert.equal(panel.hidden, false, "the panel survives that press too");

	sandbox.document.dispatchEvent({ type: "keydown", key: "Escape" });
	assert.equal(panel.hidden, true, "the final Escape closes the panel");
});

test("closing the composer returns focus to the tool that started the flow", async () => {
	const harness = bootOverlay();
	const { root, sandbox } = harness;
	await connectOverlay(harness);
	const app = appElement(harness);

	const target = root.getElementById("t-target");
	target.dispatchEvent({ type: "click" });
	sandbox.document.dispatchEvent({ type: "click", clientX: 150, clientY: 120, target: app });
	assert.equal(root.getElementById("input").focused, true, "focus moves into the composer when it opens");

	target.focused = false;
	sandbox.document.dispatchEvent({ type: "keydown", key: "Escape" });
	assert.equal(target.focused, true, "focus returns to the invoking control on close");
});

test("the dock is draggable by keyboard and its position persists", () => {
	const harness = bootOverlay();
	const { root, sandbox } = harness;
	const grip = root.getElementById("grip");
	assert.ok(grip, "the dock exposes a movable grip");

	const dock = root.getElementById("dock");
	const before = dock.style.right;
	grip.dispatchEvent({ type: "keydown", key: "ArrowLeft" });
	const after = dock.style.right;
	assert.notEqual(after, before, "arrow keys nudge the dock");
	const stored = JSON.parse(sandbox.localStorage.getItem("app-harness.dock.v1"));
	assert.ok(Number.isFinite(stored.right), "the position persists in the overlay's own storage");
});

test("the dock is closeable and reopens from a minimal handle, persisted", () => {
	const harness = bootOverlay();
	const { root, sandbox } = harness;
	const dock = root.getElementById("dock");
	const handle = root.getElementById("handle");
	assert.equal(handle.hidden, true, "the handle is absent while the dock shows");

	root.getElementById("dock-close").dispatchEvent({ type: "click" });
	assert.equal(dock.hidden, true, "closing dismisses the dock entirely");
	assert.equal(handle.hidden, false, "a minimal reopen handle remains");
	assert.equal(JSON.parse(sandbox.localStorage.getItem("app-harness.dock.v1")).closed, true, "the closed state persists");

	handle.dispatchEvent({ type: "click" });
	assert.equal(dock.hidden, false, "the handle brings the dock back");
	assert.equal(JSON.parse(sandbox.localStorage.getItem("app-harness.dock.v1")).closed, false);
});

test("a second overlay tag on the same page is a no-op, not a second surface", () => {
	const harness = createSandbox({ scriptDataset: { room: "main" } });
	runScript(overlay, harness.sandbox);
	const afterFirst = harness.documentElement.children.length;
	runScript(overlay, harness.sandbox);
	assert.equal(harness.documentElement.children.length, afterFirst, "the overlay mounts exactly once per page");
	assert.deepEqual(harness.consoleErrors, []);
});

test("the overlay ignores malformed server frames instead of dying on them", async () => {
	const harness = bootOverlay();
	const socket = await connectOverlay(harness);

	assert.doesNotThrow(() => socket.emit("message", { data: "not json at all" }));
	assert.doesNotThrow(() => socket.deliver({ type: "totally:unknown" }));
	assert.doesNotThrow(() => socket.deliver({ type: "feed:update", queue: null, items: null }));
	assert.deepEqual(harness.consoleErrors, [], "a malformed frame is ignored quietly, not logged as a crash");
});
