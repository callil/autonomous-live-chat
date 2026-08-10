import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { defineTenant, INSTALLED_TENANT, ANCHOR_MODES } from "../contracts/tenant.js";
import { structuralSelector, stableClasses, describeTarget } from "../contracts/anchor.js";

const overlay = await readFile(new URL("../src/overlay/overlay.client.js", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const firewall = await readFile(new URL("../../.github/workflows/platform-firewall.yml", import.meta.url), "utf8");
const productHtml = await readFile(new URL("../../product/src/ui/room.html", import.meta.url), "utf8");

/**
 * THE OVERLAY is a drop-in layer for an app the harness knows nothing about.
 * These tests defend the two properties that make that true: hard isolation
 * from the host app, and zero coupling to it.
 */

test("the overlay is served by the frozen platform, never by the app", () => {
	assert.match(worker, /pathname === "\/overlay\.js"/u);
	assert.match(worker, /OVERLAY_CLIENT/u);
	// The app embeds it by URL only — one script tag is the whole integration.
	assert.match(productHtml, /<script src="\/overlay\.js"/u);
});

test("the overlay is protected by the CI path firewall", () => {
	// The firewall blocks platform/* wholesale, which covers the overlay source,
	// the tenant contract, and the anchor contract added alongside it.
	assert.match(firewall, /platform\/\*/u, "agent branches cannot modify anything under platform/");
	assert.match(firewall, /room\/\*\)/u, "the firewall applies to agent branches");
});

test("style isolation is a CLOSED shadow root, so the app can neither read nor restyle it", () => {
	assert.match(overlay, /attachShadow\(\{ mode: "closed" \}\)/u);
	// Everything the overlay renders lives inside that root.
	assert.match(overlay, /root\.innerHTML/u);
	assert.doesNotMatch(overlay, /document\.head\.append/u, "the overlay never injects styles into the host document");
});

test("the overlay imports nothing from the app and assumes no framework", () => {
	assert.doesNotMatch(overlay, /^import\s/mu, "the overlay is a standalone script, not a module in the app's bundle");
	assert.doesNotMatch(overlay, /require\(/u);
	assert.doesNotMatch(overlay, /product\//u, "the overlay must not reference the example tenant's source");
	// No framework is imported, mounted, or branched on. (The class-name filter
	// names framework PREFIXES on purpose — recognizing generated class noise is
	// how the overlay stays framework-agnostic, not a dependency on one.)
	assert.doesNotMatch(overlay, /from ["']react|createApp\(|new Vue|ReactDOM/u);
});

test("the overlay does not depend on the app's markup: no hardcoded app selectors", () => {
	// The only app-side hook is the visual highlight marker it sets and removes.
	assert.match(overlay, /data-app-harness-hilite/u);
	for (const appSelector of ["#messages", "#chat-input", ".room-title", ".topbar", "#join-form"]) {
		assert.ok(!overlay.includes(appSelector), `${appSelector} is app-specific and must not appear in the overlay`);
	}
});

test("anchoring degrades to structural selectors when the app does not stamp its source", () => {
	assert.match(overlay, /anchorMode: dataLoc \? "data-loc" : "structural"/u);
	assert.match(overlay, /structuralSelector\(element\)/u);
	// data-loc is read opportunistically, never required.
	assert.match(overlay, /getAttribute\?\.\("data-loc"\)/u);
});

test("structural selectors identify an element without any build cooperation", () => {
	// A tiny DOM stand-in: enough shape for the selector walk.
	const button = {
		tagName: "BUTTON",
		className: "btn btn-primary",
		getAttribute: (name) => (name === "data-testid" ? "checkout" : null),
		parentElement: null,
	};
	const doc = { querySelectorAll: (selector) => (selector === 'button[data-testid="checkout"]' ? [button] : []) };
	const anchor = structuralSelector(button, doc);
	assert.equal(anchor.selector, 'button[data-testid="checkout"]');
	assert.equal(anchor.unique, true);
});

test("framework-generated class names are treated as noise, not identity", () => {
	assert.deepEqual(stableClasses({ className: "card css-1a2b3c sc-fzXfMB _x9k2mq header" }), ["card", "header"]);
	assert.deepEqual(stableClasses({ className: "svelte-1x2y3z ng-star-inserted" }), []);
});

test("the target description prefers the app's own words over a selector", () => {
	assert.equal(describeTarget({ tagName: "BUTTON", getAttribute: (n) => (n === "aria-label" ? "Send message" : null) }), 'aria-label="Send message"');
	assert.equal(describeTarget({ tagName: "H1", getAttribute: () => null, textContent: "  The Live Room  " }), "“The Live Room”");
});

/**
 * HIT-TESTING is asserted where it is observable: overlay-boot.test.mjs mounts
 * the real overlay, applies its real stylesheet to the real tree, and
 * hit-tests geometrically — so a container that regains pointer-events:auto
 * fails on behaviour rather than on wording.
 *
 * The defect that motivated it: the dock container was pointer-events:auto, so
 * its shrink-to-fit box swallowed clicks ~290px wide while the visible pill was
 * a fraction of that, and the host app's Send button became unclickable.
 */

test("TRUE OVERLAY: the overlay publishes no layout contract for the app to consume", async () => {
	// The overlay floats ABOVE the app with zero layout influence — the app
	// renders exactly as if the overlay were absent. The old inset-variable
	// mechanism (the overlay published its dock's occupied region and the app
	// padded around it) made the page reflow around harness chrome, which is
	// exactly what a drop-in overlay must never do. Overlap is handled on the
	// overlay's side: the dock is draggable and closeable.
	assert.doesNotMatch(overlay, /--app-harness-dock-inset/u, "the overlay must not publish inset hints");
	const css = await readFile(new URL("../../product/src/ui/room.css", import.meta.url), "utf8");
	assert.doesNotMatch(css, /--app-harness-dock-inset/u, "no app should pad itself around harness chrome");
});

test("tenancy is configuration, and the example room is just an installed tenant", () => {
	assert.equal(INSTALLED_TENANT.id, "example-room");
	assert.equal(INSTALLED_TENANT.sourceRoot, "product");
	assert.ok(ANCHOR_MODES.includes(INSTALLED_TENANT.anchorMode));
	// A third-party app with no build cooperation is a first-class tenant.
	const byo = defineTenant({ id: "acme-store", repository: "acme/store", sourceRoot: "src" });
	assert.equal(byo.anchorMode, "structural", "structural anchoring is the default, so no build plugin is required");
	assert.deepEqual(byo.testCommand, []);
});

test("a tenant descriptor refuses unsafe configuration rather than guessing", () => {
	assert.throws(() => defineTenant({ id: "x", repository: "not-a-repo", sourceRoot: "src" }), /owner\/name/u);
	assert.throws(() => defineTenant({ id: "x", repository: "a/b", sourceRoot: "../etc" }), /repository-relative/u);
	assert.throws(() => defineTenant({ id: "x", repository: "a/b", sourceRoot: "src", testCommand: "npm test && rm -rf /" }), /argv array/u);
	assert.throws(() => defineTenant({ id: "x", repository: "a/b", sourceRoot: "src", anchorMode: "magic" }), /anchorMode/u);
});
