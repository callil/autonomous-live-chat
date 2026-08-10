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
	for (const selector of [".layer", ".dock", ".draw", ".hint", ".hover-box", ".hover-chip", ".tip", ".markers"]) {
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

test("TRUE OVERLAY: chrome never touches the app's layout, and framed mode is paint-only", () => {
	const harness = bootOverlay();
	const { root, rootStyle, sandbox } = harness;
	const app = appElement(harness, { rect: { left: 40, top: 600, width: 800, height: 60 } });
	const before = JSON.stringify(app.getBoundingClientRect());

	// The harness boots OPEN, so the page is framed from the start — via
	// transform, never layout.
	assert.match(sandbox.document.body.style.getPropertyValue("transform"), /scale/u, "the open harness frames the page by transform");
	assert.ok(sandbox.document.documentElement.style.getPropertyValue("background").length > 0, "the revealed backdrop is painted behind the page");

	// Open the panel — the overlay's largest piece of chrome.
	root.getElementById("status-toggle").dispatchEvent({ type: "click" });
	assert.equal(root.getElementById("panel").hidden, false, "the panel opens");

	// The app's geometry is untouched and no inset/padding contract exists:
	// the overlay publishes NOTHING for the app to consume.
	assert.equal(JSON.stringify(app.getBoundingClientRect()), before, "the app must not reflow around overlay chrome");
	for (const name of rootStyle.properties.keys()) {
		assert.doesNotMatch(name, /inset|padding|margin|width|height/u, `the overlay must not publish layout hints (${name})`);
	}
	// Framed mode may write PAINT-ONLY properties to the body — never
	// layout-affecting ones.
	for (const name of sandbox.document.body.style.properties.keys()) {
		assert.doesNotMatch(name, /padding|margin|width|height|inset|top|left|right|bottom|font|display|position/u, `framed mode must stay paint-only (${name})`);
	}
});

test("closing the harness releases the frame and restores the page verbatim", () => {
	const harness = bootOverlay();
	const { root, sandbox } = harness;
	const html = sandbox.document.documentElement;
	const body = sandbox.document.body;
	assert.match(body.style.getPropertyValue("transform"), /scale/u, "open harness = framed page");

	// Dismiss the dock: the harness is closed, the frame releases, and every
	// inline property the overlay wrote is restored exactly.
	root.getElementById("dock-close").dispatchEvent({ type: "click" });
	harness.flushTimers(500);
	assert.equal(body.style.properties.size, 0, "the app's inline body styles are restored exactly on exit");
	assert.equal(JSON.stringify([...html.style.properties.entries()].filter(([name]) => name !== "cursor")), "[]", "the backdrop is removed verbatim on exit");

	// Reopening frames again.
	root.getElementById("handle").dispatchEvent({ type: "click" });
	assert.match(body.style.getPropertyValue("transform"), /scale/u, "reopening re-frames the page");
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
	assert.equal(root.getElementById("status-text").textContent, "1", "a verifying intent counts as active — and the dock stays terse: just the number");
	assert.equal(root.getElementById("dot").dataset.phase, "verifying", "the dot's color carries the phase");
	assert.match(root.getElementById("status-tip").textContent, /1 verifying/u, "the words live in the tooltip");

	socket.deliver({ type: "feed:update", queue: [{ intentId: "intent-1", runId: "run-1", phase: "deploying", label: "deploying" }], items: [] });
	assert.equal(root.getElementById("status-text").textContent, "1", "a deploying intent counts as active");
	assert.equal(root.getElementById("dot").dataset.phase, "deploying");
	const rows = root.getElementById("queue").children;
	assert.equal(rows.length, 1, "the pipeline entry is visible in the queue panel");

	// Only the terminal fact empties the pipeline.
	socket.deliver({ type: "feed:update", queue: [], items: [] });
	assert.equal(root.getElementById("status-text").textContent, "0", "the count returns to zero only when the pipeline is empty");
	assert.equal(root.getElementById("dot").dataset.phase, undefined, "no phase color when nothing is active");
});

test("first run: the toolbar presents itself top center and open; a placed position wins forever after", () => {
	// Fresh visitor, nothing persisted: top center, open, framed.
	const fresh = bootOverlay();
	const dock = fresh.root.getElementById("dock");
	assert.equal(dock.hidden, false, "the toolbar starts open");
	assert.ok(dock.classNames().includes("down"), "top placement: the panel would open downward");
	assert.equal(dock.style.top, "20px", "flush to a 20px top margin");
	// Centered: the pill's midpoint sits at the viewport's midpoint (1280 wide,
	// 300 fallback pill width → a 490px offset puts the center at 640).
	assert.equal(dock.style.right, "490px", "horizontally centered");

	// A returning user's dragged position beats the default.
	const harness = createSandbox({ scriptDataset: { room: "main" } });
	harness.sandbox.localStorage.setItem("app-harness.dock.v1", JSON.stringify({ right: 20, bottom: 20 }));
	runScript(overlay, harness.sandbox);
	const placedHost = harness.documentElement.children.find((child) => child.getAttribute?.("data-app-harness") === "overlay");
	const placedDock = placedHost.closedShadowRoot.getElementById("dock");
	assert.equal(placedDock.style.bottom, "20px", "the persisted position wins on return visits");
	assert.ok(!placedDock.classNames().includes("down"), "a bottom-right dock keeps its upward flyout");
});

test("closing attaches a flush tab to the nearest edge; it drags along edges and springs back out on click", () => {
	const harness = bootOverlay();
	const { root, sandbox } = harness;
	const handle = root.getElementById("handle");
	const dock = root.getElementById("dock");

	// The dock starts top-center, so the nearest edge is the TOP: the closed
	// state is a flat tab flush against it, not a floating shape.
	root.getElementById("dock-close").dispatchEvent({ type: "click" });
	assert.equal(dock.hidden, true);
	assert.equal(handle.hidden, false);
	assert.equal(handle.dataset.edge, "top", "the tab attaches to the edge nearest the pill");
	assert.equal(handle.style.top, "0px", "flush against the edge, protruding into the page");

	// Dragging along the edge moves the tab; persisted on release.
	handle.dispatchEvent({ type: "pointerdown", target: handle, clientX: 640, clientY: 8, pointerId: 1 });
	handle.dispatchEvent({ type: "pointermove", target: handle, clientX: 400, clientY: 8, buttons: 1, pointerId: 1 });
	assert.equal(handle.dataset.edge, "top", "small moves stay on the same edge");
	assert.equal(handle.style.left, `${400 - 28}px`, "the tab follows the pointer along its edge");

	// Dragging toward another edge re-attaches flush there.
	handle.dispatchEvent({ type: "pointermove", target: handle, clientX: 12, clientY: 300, buttons: 1, pointerId: 1 });
	assert.equal(handle.dataset.edge, "left", "crossing the page re-attaches to the new nearest edge");
	assert.equal(handle.style.left, "0px", "flush against the new edge");
	handle.dispatchEvent({ type: "pointerup", target: handle, pointerId: 1 });
	assert.equal(JSON.parse(sandbox.localStorage.getItem("app-harness.dock.v1")).edge, "left", "the tab's edge persists");

	// The click that ends a drag is not a jump-out…
	handle.dispatchEvent({ type: "click", target: handle });
	assert.equal(dock.hidden, true, "a drag-release click does not reopen");
	// …but a plain click springs the toolbar back out at the tab's location.
	handle.dispatchEvent({ type: "click", target: handle });
	assert.equal(dock.hidden, false, "a plain click jumps the toolbar back out");
	assert.ok(root.getElementById("pill").classNames().includes("pop"), "with the springy pop");
	assert.equal(handle.hidden, true, "the tab stands down while the toolbar is out");
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

test("pending intents pin numbered markers to the elements they target", async () => {
	const harness = bootOverlay();
	const { root, sandbox } = harness;
	const socket = await connectOverlay(harness);
	const app = appElement(harness, { dataLoc: "src/ui/page.html:42:3" });
	assert.ok(app, "the app element exists to be pinned");

	socket.deliver({
		type: "feed:update",
		items: [],
		queue: [{ intentId: "i1", phase: "building", label: "building", text: "Make it pop", by: "Ada", anchor: { kind: "target", dataLoc: "src/ui/page.html:42:3", selector: "button.checkout" } }],
	});
	const markers = root.getElementById("markers");
	assert.equal(markers.children.length, 1, "one pending intent, one marker pin");
	const marker = markers.children[0];
	assert.equal(marker.textContent, "1", "markers are numbered");
	assert.equal(marker.dataset.phase, "building", "the pin carries its phase");
	assert.match(marker.getAttribute("aria-label") ?? "", /Make it pop/u, "the pin names the request");

	// The marker retires with the intent's terminal fact.
	socket.deliver({ type: "feed:update", items: [], queue: [] });
	harness.flushTimers(300);
	assert.equal(markers.children.filter((child) => !child.classNames().includes("exit")).length, 0, "a finished intent's marker exits");
});

test("queue rows read as sentences: quoted request, requester, and phase", async () => {
	const harness = bootOverlay();
	const { root } = harness;
	const socket = await connectOverlay(harness);
	socket.deliver({
		type: "feed:update",
		items: [],
		queue: [{ intentId: "i1", phase: "verifying", label: "verifying", text: "Make this tagline italic.", by: "Maya" }],
	});
	const row = root.getElementById("queue").children[0];
	assert.ok(row, "the pipeline entry renders a row");
	const rowText = row.descendants().map((node) => node.textContent).join(" ");
	assert.match(rowText, /Make this tagline italic\./u, "the verbatim request is readable at a glance");
	assert.match(rowText, /Maya/u, "the requester is named");
	assert.match(rowText, /verifying/u, "the phase is visible");
});

test("selected text rides the envelope and is quoted in the composer", async () => {
	const harness = createSandbox({ scriptDataset: { room: "main", anchorMode: "data-loc" } });
	harness.sandbox.getSelection = () => ({ isCollapsed: false, toString: () => "picked words" });
	runScript(overlay, harness.sandbox);
	const host = harness.documentElement.children.find((child) => child.getAttribute?.("data-app-harness") === "overlay");
	const root = host.closedShadowRoot;
	const socket = await connectOverlay(harness);
	const app = appElement(harness);

	root.getElementById("t-target").dispatchEvent({ type: "click" });
	harness.sandbox.document.dispatchEvent({ type: "click", clientX: 150, clientY: 120, target: app });

	const quote = root.getElementById("quote");
	assert.equal(quote.hidden, false, "the selection is shown in the composer");
	assert.match(quote.textContent, /picked words/u);

	root.getElementById("input").value = "reword this";
	root.getElementById("composer").dispatchEvent({ type: "submit" });
	const frame = socket.sent.map((raw) => JSON.parse(raw)).find((message) => message.type === "request:target");
	assert.equal(frame.annotation.selectedText, "picked words", "the exact phrase rides the envelope");
});

test("a drag whose pointer was released elsewhere does not keep following the cursor", () => {
	const harness = bootOverlay();
	const { root } = harness;
	const pill = root.getElementById("pill");
	pill.dispatchEvent({ type: "pointerdown", target: pill, clientX: 600, clientY: 700, pointerId: 1 });
	// The pointer comes back over the pill with NO buttons pressed: the lost
	// drag must end rather than yank the dock around.
	const before = root.getElementById("dock").style.right;
	pill.dispatchEvent({ type: "pointermove", target: pill, clientX: 300, clientY: 200, buttons: 0, pointerId: 1 });
	assert.equal(root.getElementById("dock").style.right, before, "an unpressed pointer never drags the dock");
});

test("the panel opens toward available space when the dock sits in the top-left", () => {
	const harness = createSandbox({ scriptDataset: { room: "main" } });
	harness.sandbox.localStorage.setItem("app-harness.dock.v1", JSON.stringify({ right: 950, bottom: 640 }));
	runScript(overlay, harness.sandbox);
	const host = harness.documentElement.children.find((child) => child.getAttribute?.("data-app-harness") === "overlay");
	const root = host.closedShadowRoot;
	const dock = root.getElementById("dock");
	// 1280x720 viewport, dock pinned near the top-left corner: the flyout must
	// anchor top/left so the panel opens down and to the right — never
	// clipped off-screen.
	assert.ok(dock.classNames().includes("down"), "a top-half dock opens its panel downward");
	assert.ok(dock.classNames().includes("start"), "a left-half dock grows its panel rightward");
	assert.notEqual(dock.style.top, "auto", "the dock anchors by the edge it opens away from");
});

test("the harness's own chrome is annotatable in a distinct feedback mode that never dispatches a build", async () => {
	const harness = bootOverlay();
	const { root } = harness;
	const socket = await connectOverlay(harness);

	root.getElementById("t-target").dispatchEvent({ type: "click" });
	// Hovering harness chrome switches the preview into the feedback style —
	// the user sees they are pointing at the harness, not the app.
	const pill = root.getElementById("pill");
	pill.dispatchEvent({ type: "mousemove", target: pill, clientX: 640, clientY: 700 });
	const box = root.getElementById("hover-box");
	assert.equal(box.hidden, false, "harness chrome previews too");
	assert.ok(box.classNames().includes("harness"), "in a visibly different style than app elements");
	assert.match(root.getElementById("chip-name").textContent, /App Harness UI/u, "the chip says what is being pointed at");

	// Option-click opens the composer in harness-feedback mode.
	pill.dispatchEvent({ type: "click", target: pill, altKey: true, clientX: 640, clientY: 700 });
	const composer = root.getElementById("composer");
	assert.equal(composer.hidden, false, "the composer opens for harness feedback");

	root.getElementById("input").value = "The dock hides my send button";
	composer.dispatchEvent({ type: "submit" });
	const frames = socket.sent.map((raw) => JSON.parse(raw));
	const feedback = frames.find((message) => message.type === "harness:feedback");
	assert.ok(feedback, "feedback rides its own message type");
	assert.equal(feedback.annotation.kind, "harness-feedback");
	assert.ok(feedback.annotation.selectorPath.length > 0, "the anchored chrome element rides the payload");
	// The architectural guarantee: harness feedback is NEVER a build request.
	assert.ok(!frames.some((message) => String(message.type).startsWith("request:")), "no request envelope is ever sent for harness feedback");

	socket.deliver({ type: "harness:ack" });
	assert.match(root.getElementById("msg").textContent, /outside this room/u, "the ack is honest: the harness improves outside the room's pipeline");
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
