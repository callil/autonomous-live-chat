/**
 * THE APP HARNESS OVERLAY — platform-owned, frozen, agent-unmodifiable.
 *
 * This script attaches the authoring tools and the status surface (build
 * queue, activity feed, per-item provenance) to an app it knows NOTHING
 * about. It is the drop-in layer `npx app-harness init` installs into a
 * third-party application. Its look and interaction model deliberately copy
 * benjitaylor/agentation (the toolbar, the hover-highlight preview of the
 * element you are about to annotate, the label chip, the dark/light theming),
 * re-implemented in dependency-free vanilla JS inside a closed shadow root.
 *
 * Isolation contract (why this file is safe against an app that agents keep
 * rewriting):
 *  - CLOSED shadow root. Host CSS cannot reach in (no inheritance, no
 *    selector match), overlay CSS cannot leak out, and the app cannot even
 *    obtain the root to poke at it. The app may restyle itself completely and
 *    this surface is unaffected.
 *  - Zero imports from the app. No shared bundle, no shared stylesheet, no
 *    framework, no build step. One <script> tag, served by the platform.
 *  - Every value rendered here comes from the platform's durable-fact
 *    projection over the room WebSocket. The app cannot write to it, so an
 *    agent change to the app can neither break nor falsify the status surface.
 *
 * TRUE-OVERLAY contract (hard invariant): the overlay NEVER influences the
 * app's layout. No inset variables are published, no padding is expected of
 * the app, and nothing here causes a reflow of the page underneath — the app
 * renders exactly as if the overlay were absent. Overlap is handled on the
 * overlay's side: the dock is compact, draggable, and closeable. The one
 * page-level effect the overlay owns — FRAMED MODE, which insets the page
 * ~8px onto a slow gradient while the harness is open — is done purely with
 * a transform (paint, never layout) and is restored verbatim on exit.
 *
 * The overlay reads the app's DOM (to hit-test what a requester points at) and
 * never depends on its structure: anchoring degrades from data-loc refs to
 * structural selectors automatically. The only writes to the app's DOM are
 * visual and reversible: the selection highlight attribute, and the framed-
 * mode inline transform/background pair, both removed on exit.
 *
 * It also never captures a click it does not draw: every container here is
 * pointer-events:none and only visible leaf controls opt back in, so an app
 * that knows nothing about this overlay keeps all of its own controls.
 */
(() => {
	"use strict";

	const script = document.currentScript;
	const config = {
		// Same-origin by default: the app proxies /api/* to the platform, so the
		// signed session cookie is a plain first-party cookie.
		apiBase: script?.dataset?.apiBase || "",
		room: script?.dataset?.room || "main",
		repoUrl: script?.dataset?.repoUrl || "",
		anchorMode: script?.dataset?.anchorMode === "data-loc" ? "data-loc" : "structural",
	};

	if (window.__appHarnessOverlay) return;
	window.__appHarnessOverlay = { version: 2 };

	const MAX_SNAPSHOT_CHARS = 4000;
	const STYLE_KEYS = ["color", "background-color", "font-size", "font-weight", "padding", "margin", "border", "border-radius", "display"];
	const MIN_DRAW_DISTANCE = 3;
	const GUTTER = 12;
	const STABLE_ATTRIBUTES = ["data-testid", "data-test", "data-qa", "data-component", "id", "name", "aria-label", "role"];
	const MAX_SELECTOR_DEPTH = 5;
	const UNSTABLE_CLASS = /^(?:[a-z]+-)?[a-f0-9]{5,}$|^css-|^sc-|^jsx-|^_[A-Za-z0-9]{4,}|^ng-|^svelte-/u;
	const STORAGE_KEY = "app-harness.dock.v1";

	// ---- Anchoring (mirrors platform/contracts/anchor.js; kept dependency-free
	// so the overlay stays one standalone file an app can drop in) ------------

	const cssSafe = (value) => /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(value);

	function stableAttribute(element) {
		for (const name of STABLE_ATTRIBUTES) {
			const value = element?.getAttribute?.(name);
			if (typeof value === "string" && value.length > 0 && value.length <= 120 && !UNSTABLE_CLASS.test(value)) return { name, value };
		}
		return null;
	}

	function stableClasses(element) {
		const list = typeof element?.className === "string" ? element.className.trim().split(/\s+/u) : [];
		return list.filter((name) => name && !UNSTABLE_CLASS.test(name) && cssSafe(name)).slice(0, 3);
	}

	function segmentFor(element) {
		const tag = String(element.tagName || "").toLowerCase();
		if (!tag) return null;
		const attribute = stableAttribute(element);
		if (attribute) {
			if (attribute.name === "id" && cssSafe(attribute.value)) return `#${attribute.value}`;
			return `${tag}[${attribute.name}="${attribute.value.replaceAll('"', '\\"')}"]`;
		}
		const classes = stableClasses(element);
		return classes.length ? `${tag}.${classes.join(".")}` : tag;
	}

	function nthOfType(element) {
		const parent = element.parentElement;
		if (!parent) return null;
		const sameTag = [...parent.children].filter((child) => child.tagName === element.tagName);
		return sameTag.length < 2 ? null : sameTag.indexOf(element) + 1;
	}

	function structuralSelector(element) {
		if (!element || !element.tagName) return null;
		const parts = [];
		let current = element;
		for (let depth = 0; depth < MAX_SELECTOR_DEPTH && current && current.tagName; depth += 1) {
			let segment = segmentFor(current);
			if (!segment) break;
			if (depth === 0) {
				const index = nthOfType(current);
				if (index !== null && !segment.startsWith("#")) segment = `${segment}:nth-of-type(${index})`;
			}
			parts.unshift(segment);
			const selector = parts.join(" > ");
			if (segment.startsWith("#")) return { selector, unique: true };
			let matches = null;
			try { matches = document.querySelectorAll(selector); } catch { matches = null; }
			if (matches && matches.length === 1) return { selector, unique: true };
			current = current.parentElement;
		}
		if (!parts.length) return null;
		const selector = parts.join(" > ");
		let unique = false;
		try { unique = document.querySelectorAll(selector).length === 1; } catch { unique = false; }
		return { selector, unique };
	}

	/**
	 * A short human-readable ancestor path (agentation's element identification,
	 * ported minimally): `main > .messages > .message`. Shown on the hover chip
	 * so the user sees what they are about to target BEFORE clicking, and sent
	 * on the envelope as an extra structural hint alongside data-loc.
	 */
	function readablePath(element, maxDepth = 4) {
		const parts = [];
		let current = element;
		for (let depth = 0; depth < maxDepth && current && current.tagName; depth += 1) {
			const tag = String(current.tagName).toLowerCase();
			if (tag === "html" || tag === "body") break;
			let identity = tag;
			const id = current.getAttribute?.("id");
			if (typeof id === "string" && id.length && cssSafe(id)) identity = `#${id}`;
			else {
				const classes = stableClasses(current);
				if (classes.length) identity = `.${classes[0]}`;
			}
			parts.unshift(identity);
			current = current.parentElement;
		}
		return parts.join(" > ");
	}

	function describeTarget(element) {
		const attribute = stableAttribute(element);
		if (attribute && attribute.name !== "role") return `${attribute.name}="${attribute.value}"`;
		const text = typeof element?.textContent === "string" ? element.textContent.trim().replaceAll(/\s+/gu, " ") : "";
		if (text) return `“${text.length > 48 ? `${text.slice(0, 47)}…` : text}”`;
		return String(element?.tagName || "element").toLowerCase();
	}

	/**
	 * The annotation envelope. `dataLoc` is present only when the app opted
	 * into stamping; `selector`, `selectorPath`, and `domSnapshot` are ALWAYS
	 * present, and are what make this work against an app with no build
	 * cooperation at all. Richer anchors mean better builds; the payload is
	 * stored verbatim by the platform.
	 */
	function captureEnvelope(element) {
		const rect = element.getBoundingClientRect();
		const computed = getComputedStyle(element);
		const computedStyles = {};
		for (const key of STYLE_KEYS) computedStyles[key] = computed.getPropertyValue(key);
		const structural = structuralSelector(element);
		const dataLoc = element.getAttribute?.("data-loc") || element.closest?.("[data-loc]")?.getAttribute("data-loc") || null;
		const tag = String(element.tagName || "").toLowerCase();
		return {
			// The ledger requires a non-empty dataLoc; the structural selector is
			// the honest stand-in when the app does not stamp its source.
			dataLoc: dataLoc || (structural ? `dom:${structural.selector}` : `dom:${tag || "node"}`),
			anchorMode: dataLoc ? "data-loc" : "structural",
			selector: structural ? structural.selector : null,
			selectorUnique: structural ? structural.unique : false,
			selectorPath: readablePath(element),
			label: describeTarget(element),
			domSnapshot: (typeof element.outerHTML === "string" && element.outerHTML.length ? element.outerHTML : `<${tag || "node"}>`).slice(0, MAX_SNAPSHOT_CHARS),
			tag,
			page: location.pathname,
			rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
			computedStyles,
			viewport: { width: innerWidth, height: innerHeight },
		};
	}

	// ---- Isolated surface ----------------------------------------------------

	const host = document.createElement("div");
	host.setAttribute("data-app-harness", "overlay");
	// The host element itself is positioned; everything inside is shadowed.
	// It mounts on <html>, NOT <body>: framed mode transforms <body>, and the
	// overlay's chrome must stay at true viewport scale above the shrunk page.
	host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
	// A CLOSED root: the app cannot reach in via host.shadowRoot.
	const root = host.attachShadow({ mode: "closed" });

	// Small crisp stroke icons in agentation's style (24 viewBox, 1.5 stroke).
	const ICONS = {
		target: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M5 4.5 10.2 19l2.1-5.6L18 11.2 5 4.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="m13 13.5 4.8 4.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
		comment: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M12 4.5c-4.1 0-7.5 3-7.5 6.8 0 3.7 3.4 6.7 7.5 6.7.9 0 1.8-.1 2.6-.4l3.6 1.1-.9-3c1.1-1.2 1.8-2.7 1.8-4.4 0-3.8-3.4-6.8-7.1-6.8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="9" cy="11.3" r="1" fill="currentColor"/><circle cx="12" cy="11.3" r="1" fill="currentColor"/><circle cx="15" cy="11.3" r="1" fill="currentColor"/></svg>',
		draw: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="m14.5 5.6 3.9 3.9L8.9 19 4.5 19.5 5 15.1l9.5-9.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="m13 7.1 3.9 3.9" stroke="currentColor" stroke-width="1.5"/></svg>',
		activity: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M11.5 12H5.5M18.5 6.75H5.5M9.25 17.25H5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="m16 12.75.52 1.22c.29.68.83 1.22 1.51 1.51l1.22.52-1.22.52c-.68.29-1.22.83-1.51 1.51L16 19.25l-.52-1.22c-.29-.68-.83-1.22-1.51-1.51L12.75 16l1.22-.52c.68-.29 1.22-.83 1.51-1.51L16 12.75Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
		close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"><path d="m6.5 6.5 11 11m0-11-11 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
		grip: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/></svg>',
		sparkle: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M12 5.5l1.1 2.9c.4 1 1.2 1.8 2.2 2.2l2.9 1.1-2.9 1.1c-1 .4-1.8 1.2-2.2 2.2L12 18.5l-1.1-2.9c-.4-1-1.2-1.8-2.2-2.2L5.8 12.3l2.9-1.1c1-.4 1.8-1.2 2.2-2.2L12 5.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
		eye: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M4.5 12S7.5 6.75 12 6.75 19.5 12 19.5 12 16.5 17.25 12 17.25 4.5 12 4.5 12Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.4" stroke="currentColor" stroke-width="1.5"/></svg>',
	};

	root.innerHTML = `
<style>
	:host, * { box-sizing: border-box; }
	/* Every value is stated explicitly: nothing is inherited from the app.
	   Visual language ported from agentation's toolbar/popup SCSS: #1a1a1a
	   surfaces, 44px pill, circular icon buttons, 16px-radius panels, the
	   accent color tokens, and the hoverHighlightIn/hoverTooltipIn timing. */
	.layer {
		position: fixed; inset: 0; pointer-events: none;
		--accent: #0088FF; --green: #34C759; --yellow: #FFCC00; --red: #FF383C;
		--chrome: #1a1a1a; --chrome-hover: rgba(255, 255, 255, 0.12);
		--ink: rgba(255, 255, 255, 0.85); --ink-dim: rgba(255, 255, 255, 0.5);
		--ink-faint: rgba(255, 255, 255, 0.35); --ring: rgba(255, 255, 255, 0.08);
		--well: rgba(255, 255, 255, 0.05); --edge: rgba(255, 255, 255, 0.15);
		font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		font-size: 13px; line-height: 1.45; font-weight: 400; font-style: normal;
		letter-spacing: normal; text-transform: none; text-align: left;
		color: var(--ink); direction: ltr; color-scheme: dark;
	}
	@supports (color: color(display-p3 0 0 0)) {
		.layer { --accent: color(display-p3 0 0.53 1); --green: color(display-p3 0.2 0.78 0.35); }
	}
	@media (prefers-color-scheme: light) {
		.layer {
			--chrome: #ffffff; --chrome-hover: rgba(0, 0, 0, 0.07);
			--ink: rgba(0, 0, 0, 0.85); --ink-dim: rgba(0, 0, 0, 0.5);
			--ink-faint: rgba(0, 0, 0, 0.35); --ring: rgba(0, 0, 0, 0.08);
			--well: rgba(0, 0, 0, 0.04); --edge: rgba(0, 0, 0, 0.15);
			color-scheme: light;
		}
	}

	@keyframes hoverHighlightIn { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }
	@keyframes hoverTooltipIn { from { opacity: 0; transform: scale(0.95) translateY(4px); } to { opacity: 1; transform: scale(1) translateY(0); } }
	@keyframes popupEnter { from { opacity: 0; transform: scale(0.95) translateY(4px); } to { opacity: 1; transform: scale(1) translateY(0); } }
	@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
	@media (prefers-reduced-motion: reduce) {
		.hover-box, .hover-chip, .composer, .panel { animation: none !important; }
		.dot.busy { animation: none; }
	}

	.draw { position: fixed; inset: 0; pointer-events: none; }
	.draw.active { pointer-events: auto; cursor: crosshair; }
	.draw path { fill: none; stroke: var(--accent); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }

	/* HOVER PREVIEW (agentation's headline interaction). The whole preview
	   lane is pointer-events:none: it must never affect hit-testing, so the
	   element under the cursor is always the app's own. */
	.hover-box {
		position: fixed; pointer-events: none !important;
		border: 2px solid color-mix(in srgb, var(--accent) 50%, transparent);
		border-radius: 4px;
		background: color-mix(in srgb, var(--accent) 4%, transparent);
		will-change: opacity; contain: layout style;
	}
	.hover-box.enter { animation: hoverHighlightIn 0.12s ease-out forwards; }
	.hover-box[hidden] { display: none !important; }
	/* SELF-ANNOTATION: hovering the harness's own chrome while armed switches
	   the preview into a distinct feedback style — indigo, clearly not the
	   app — and ⌥-click opens the composer in harness-feedback mode. */
	.hover-box.harness {
		border-color: color-mix(in srgb, #6155F5 60%, transparent);
		background: color-mix(in srgb, #6155F5 6%, transparent);
	}
	.hover-chip.harness { background: #6155F5; }
	.hover-chip {
		position: fixed; pointer-events: none !important;
		max-width: 320px; padding: 5px 9px; border-radius: 6px;
		background: rgba(0, 0, 0, 0.85); color: #fff;
		font-size: 11px; font-weight: 500; white-space: nowrap; overflow: hidden;
	}
	.hover-chip.enter { animation: hoverTooltipIn 0.1s ease-out forwards; }
	.hover-chip[hidden] { display: none !important; }
	.chip-path { font-size: 10px; color: rgba(255, 255, 255, 0.6); overflow: hidden; text-overflow: ellipsis; }
	.chip-path:empty { display: none; }
	.chip-name { overflow: hidden; text-overflow: ellipsis; }

	/* HIT-TESTING CONTRACT. Every container in this overlay is
	   pointer-events:none; only the leaf controls the user can actually see
	   take pointer-events:auto. A container that captures clicks swallows them
	   across its whole box, which is invisible to the eye and fatal to the app
	   underneath. The app beneath must receive every click that does not land
	   on a real control, and no app should have to know this overlay exists. */
	.dock {
		position: fixed; right: 20px; bottom: 20px; pointer-events: none;
		display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
		max-height: calc(100vh - 40px);
	}
	.dock[hidden] { display: none !important; }

	.pill {
		display: flex; align-items: center; gap: 4px; height: 44px; padding: 5px;
		pointer-events: auto; cursor: default;
		background: var(--chrome); border-radius: 22px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2), 0 4px 16px rgba(0, 0, 0, 0.1), 0 0 0 1px var(--ring);
	}
	.wrap { position: relative; display: flex; align-items: center; justify-content: center; }
	.tool, .icon-btn, .grip {
		appearance: none; border: 0; background: transparent; color: var(--ink);
		display: flex; align-items: center; justify-content: center;
		width: 34px; height: 34px; border-radius: 50%; cursor: pointer; padding: 0;
		transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease;
	}
	.tool:hover, .icon-btn:hover, .grip:hover { background: var(--chrome-hover); }
	.tool:active, .icon-btn:active { transform: scale(0.92); }
	.tool[aria-pressed="true"] {
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 25%, transparent);
	}
	.grip { width: 20px; color: var(--ink-faint); cursor: grab; border-radius: 10px; }
	.grip:active { cursor: grabbing; }
	:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

	/* Per-control tooltips, agentation-style: dark, above, arrowed, delayed. */
	.tip {
		position: absolute; bottom: calc(100% + 14px); left: 50%;
		transform: translateX(-50%) scale(0.95);
		padding: 6px 10px; border-radius: 8px; background: #1a1a1a;
		color: rgba(255, 255, 255, 0.9); font-size: 12px; font-weight: 500;
		white-space: nowrap; opacity: 0; visibility: hidden;
		pointer-events: none !important;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
		transition: opacity 0.135s ease, transform 0.135s ease, visibility 0.135s ease;
	}
	.tip::after {
		content: ""; position: absolute; top: calc(100% - 4px); left: 50%;
		transform: translateX(-50%) rotate(45deg);
		width: 8px; height: 8px; background: #1a1a1a; border-radius: 0 0 2px 0;
	}
	.wrap:hover .tip, .wrap:has(:focus-visible) .tip {
		opacity: 1; visibility: visible; transform: translateX(-50%) scale(1);
		transition-delay: 0.85s;
	}
	.divider { width: 1px; height: 12px; background: var(--edge); margin: 0 3px; pointer-events: none; }

	.status {
		appearance: none; border: 0; background: transparent; color: var(--ink);
		display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px;
		border-radius: 17px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 500;
		transition: background-color 0.15s ease;
	}
	.status:hover { background: var(--chrome-hover); }
	.status[aria-expanded="true"] { background: color-mix(in srgb, var(--accent) 25%, transparent); color: var(--accent); }
	/* The dock is terse: the number carries the load, the dot carries the
	   phase (its color follows the leading item through the pipeline). The
	   tooltip and the panel keep the words. */
	.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-faint); flex: none; transition: background-color 0.3s ease; }
	.dot.busy { background: var(--yellow); animation: pulse 1.6s ease-in-out infinite; }
	.dot.live { background: var(--green); }
	.dot[data-phase="accepted"] { background: #8E8E93; }
	.dot[data-phase="queued"] { background: var(--accent); }
	.dot[data-phase="building"] { background: var(--yellow); }
	.dot[data-phase="verifying"] { background: #FF8D28; }
	.dot[data-phase="deploying"] { background: var(--green); }
	.dot[data-phase="reviewing"] { background: var(--red); }

	/* The closed state: a flat tab attached flush to the nearest page edge
	   (a browser-devtools-style lip), draggable along its edge, jumping back
	   out to the full toolbar on click. Never a floating shape in space. */
	.handle {
		position: fixed; pointer-events: auto;
		appearance: none; border: 0; padding: 0; cursor: grab;
		display: flex; align-items: center; justify-content: center;
		background: var(--chrome); color: var(--ink-dim);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25), 0 0 0 1px var(--ring);
		transition: color 0.15s ease;
	}
	.handle:active { cursor: grabbing; }
	.handle:hover { color: var(--accent); }
	.handle[hidden] { display: none !important; }
	.handle[data-edge="top"] { width: 56px; height: 18px; border-radius: 0 0 10px 10px; }
	.handle[data-edge="bottom"] { width: 56px; height: 18px; border-radius: 10px 10px 0 0; }
	.handle[data-edge="left"] { width: 18px; height: 56px; border-radius: 0 10px 10px 0; }
	.handle[data-edge="right"] { width: 18px; height: 56px; border-radius: 10px 0 0 10px; }
	.handle-line { width: 22px; height: 4px; border-radius: 2px; background: currentColor; opacity: 0.7; }
	.handle[data-edge="left"] .handle-line, .handle[data-edge="right"] .handle-line { width: 4px; height: 22px; }

	/* The jump-out: agentation's springy popupEnter feel on the whole pill. */
	@keyframes dockPop { from { opacity: 0; transform: scale(0.6); } to { opacity: 1; transform: scale(1); } }
	.pill.pop { animation: dockPop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
	@media (prefers-reduced-motion: reduce) { .pill.pop { animation: none; } }

	.panel {
		width: min(24rem, calc(100vw - 40px)); max-height: min(30rem, calc(100vh - 104px));
		display: flex; flex-direction: column; overflow: hidden; pointer-events: auto; cursor: default;
		background: color-mix(in srgb, var(--chrome) 96%, transparent);
		-webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
		border-radius: 16px;
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3), 0 0 0 1px var(--ring);
		animation: popupEnter 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.panel[hidden] { display: none !important; }
	.panel-head {
		display: flex; align-items: center; justify-content: space-between; gap: 8px;
		padding: 12px 10px 10px 16px; flex: none;
	}
	.panel-title { font-size: 13px; font-weight: 600; color: var(--ink); letter-spacing: -0.1px; }
	.panel-sub { font-size: 11px; color: var(--ink-dim); }
	.icon-btn.small { width: 28px; height: 28px; color: var(--ink-dim); }
	.icon-btn.small:hover { color: var(--ink); }
	.panel-body { overflow-y: auto; overscroll-behavior: contain; padding: 0 8px 10px; }
	.section-label {
		font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-faint);
		padding: 8px 8px 5px; font-weight: 600;
	}
	.queue { display: flex; flex-direction: column; gap: 4px; padding: 0 4px; }
	.queue-item {
		display: flex; align-items: center; gap: 8px; padding: 7px 10px;
		background: var(--well); border-radius: 8px; font-size: 12px; color: var(--ink);
	}
	.queue-item .phase-label { color: var(--ink-dim); margin-left: auto; font-size: 11px; }
	.queue-empty, .feed-empty { padding: 2px 8px 8px; font-size: 12px; color: var(--ink-faint); }
	.feed { list-style: none; margin: 0; padding: 0 8px; display: flex; flex-direction: column; }
	.feed li {
		padding: 7px 0; border-bottom: 1px solid var(--well); font-size: 12px; color: var(--ink-dim);
		display: flex; flex-direction: column; gap: 3px; overflow-wrap: anywhere;
	}
	.feed li:last-child { border-bottom: 0; }
	.feed .kind-run-failed, .feed .kind-run-parked, .feed .kind-liveness-failed { color: var(--red); }
	.feed .kind-run-merged, .feed .kind-deploy-observed { color: var(--green); }
	.prov { display: flex; gap: 8px; flex-wrap: wrap; }
	.prov a { color: var(--accent); text-decoration: none; font-size: 11px; font-variant-numeric: tabular-nums; }
	.prov a:hover { text-decoration: underline; }

	.composer {
		position: fixed; width: 300px; max-width: calc(100vw - 24px); pointer-events: auto;
		display: flex; flex-direction: column; gap: 8px; padding: 12px 14px 12px;
		background: var(--chrome); border-radius: 16px; margin: 0;
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3), 0 0 0 1px var(--ring);
		animation: popupEnter 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.composer[hidden] { display: none !important; }
	.context { font-size: 12px; color: var(--ink-dim); word-break: break-word; }
	.composer textarea {
		width: 100%; resize: none; min-height: 3.6em; padding: 8px 10px;
		background: var(--well); color: var(--ink); border: 1px solid var(--edge); border-radius: 8px;
		font: inherit; font-size: 13px; outline: none;
		transition: border-color 0.15s ease;
	}
	.composer textarea:focus { border-color: var(--accent); }
	.composer textarea::placeholder { color: var(--ink-faint); }
	.actions { display: flex; justify-content: flex-end; gap: 6px; }
	.btn {
		appearance: none; border: 0; font: inherit; font-size: 12px; font-weight: 500;
		padding: 7px 14px; border-radius: 16px; cursor: pointer;
		transition: background-color 0.15s ease, color 0.15s ease, opacity 0.15s ease, filter 0.15s ease;
	}
	.btn.cancel { background: transparent; color: var(--ink-dim); }
	.btn.cancel:hover { background: var(--chrome-hover); color: var(--ink); }
	.btn.primary { background: var(--accent); color: #fff; }
	.btn.primary:hover:not(:disabled) { filter: brightness(0.9); }
	.btn:disabled { opacity: 0.55; cursor: not-allowed; }
	.msg { font-size: 11px; color: var(--red); margin: 0; min-height: 1em; }
	.msg.ok { color: var(--green); }

	.hint {
		position: fixed; left: 50%; transform: translateX(-50%); top: 16px;
		background: rgba(0, 0, 0, 0.85); border-radius: 999px;
		padding: 6px 14px; font-size: 12px; color: rgba(255, 255, 255, 0.9);
		pointer-events: none !important;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
	}
	.hint[hidden] { display: none !important; }
	.hint .kbd { opacity: 0.5; margin-left: 4px; }

	/* INTENT MARKERS (agentation's annotation markers mapped onto our domain):
	   numbered pins on the elements pending intents target, colored by phase.
	   The layer is pointer-transparent; only the pins themselves are hittable. */
	.markers { position: fixed; inset: 0; pointer-events: none; }
	@keyframes markerIn { from { opacity: 0; transform: scale(0); } to { opacity: 1; transform: scale(1); } }
	@keyframes markerOut { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(0); } }
	.marker {
		position: fixed; pointer-events: auto; appearance: none; border: 0;
		min-width: 24px; height: 24px; padding: 0 6px; border-radius: 12px;
		display: flex; align-items: center; justify-content: center; cursor: pointer;
		background: var(--accent); color: #fff; font: inherit; font-size: 11px; font-weight: 600;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25), 0 0 0 2px rgba(255, 255, 255, 0.35);
		transition: transform 0.15s ease;
	}
	.marker:hover { transform: scale(1.12); }
	.marker.enter { animation: markerIn 0.3s cubic-bezier(0.34, 1.2, 0.64, 1); }
	.marker.exit { animation: markerOut 0.18s ease-in forwards; pointer-events: none; }
	.marker[data-phase="accepted"] { background: #8E8E93; }
	.marker[data-phase="queued"] { background: var(--accent); }
	.marker[data-phase="building"] { background: var(--yellow); color: #1a1a1a; }
	.marker[data-phase="verifying"] { background: #FF8D28; }
	.marker[data-phase="deploying"] { background: var(--green); }
	.marker[data-phase="reviewing"] { background: var(--red); }
	@media (prefers-reduced-motion: reduce) { .marker.enter, .marker.exit { animation: none; } }

	/* Descriptive queue rows: phase dot, quoted request, requester, position. */
	.queue-item .req { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.queue-item .meta { flex: none; color: var(--ink-dim); font-size: 11px; white-space: nowrap; }
	.queue-item.flash { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 60%, transparent); }
	.queue-item { transition: box-shadow 0.3s ease; }
	.phase-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--ink-faint); }
	.phase-dot[data-phase="accepted"] { background: #8E8E93; }
	.phase-dot[data-phase="queued"] { background: var(--accent); }
	.phase-dot[data-phase="building"] { background: var(--yellow); }
	.phase-dot[data-phase="verifying"] { background: #FF8D28; }
	.phase-dot[data-phase="deploying"] { background: var(--green); }
	.phase-dot[data-phase="reviewing"] { background: var(--red); }

	/* The selected-text quote inside the composer (agentation's .quote). */
	.quote {
		font-size: 12px; font-style: italic; color: var(--ink-dim);
		padding: 6px 8px; background: var(--well); border-radius: 6px; line-height: 1.45;
		overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
	}
	.quote[hidden] { display: none !important; }

	/* Position-aware flyout: the dock knows which corner it lives in and the
	   panel opens toward the available space, never off-screen. */
	.dock.down { flex-direction: column-reverse; }
	.dock.start { align-items: flex-start; }
</style>
<div class="layer">
	<svg class="draw" id="draw" aria-hidden="true"></svg>
	<div class="markers" id="markers"></div>
	<div class="hover-box" id="hover-box" hidden></div>
	<div class="hover-chip" id="hover-chip" hidden>
		<div class="chip-path" id="chip-path"></div>
		<div class="chip-name" id="chip-name"></div>
	</div>
	<div class="hint" id="hint" hidden role="status"></div>
	<div class="dock" id="dock">
		<div class="panel" id="panel" hidden role="dialog" aria-label="App Harness build activity">
			<div class="panel-head">
				<div>
					<div class="panel-title">Build activity</div>
					<div class="panel-sub" id="panel-sub">Connecting…</div>
				</div>
				<button class="icon-btn small" id="panel-close" type="button" aria-label="Close activity panel" tabindex="-1">${ICONS.close}</button>
			</div>
			<div class="panel-body">
				<div class="section-label">Queue</div>
				<div class="queue" id="queue"></div>
				<div class="queue-empty" id="queue-empty">Nothing building right now.</div>
				<div class="section-label">Activity</div>
				<ol class="feed" id="feed"></ol>
				<div class="feed-empty" id="feed-empty">No activity yet.</div>
				<div class="section-label" id="harness-feed-label" hidden>Harness feedback</div>
				<ol class="feed" id="harness-feed"></ol>
			</div>
		</div>
		<div class="pill" id="pill" role="toolbar" aria-label="App Harness tools">
			<button class="grip" id="grip" type="button" aria-label="Move the toolbar (drag, or press arrow keys)">${ICONS.grip}</button>
			<span class="wrap">
				<button class="tool" id="t-target" type="button" aria-pressed="false" aria-label="Target an element and request a change">${ICONS.target}</button>
				<span class="tip" aria-hidden="true">Target</span>
			</span>
			<span class="wrap">
				<button class="tool" id="t-comment" type="button" aria-pressed="false" aria-label="Comment on an element">${ICONS.comment}</button>
				<span class="tip" aria-hidden="true">Comment</span>
			</span>
			<span class="wrap">
				<button class="tool" id="t-draw" type="button" aria-pressed="false" aria-label="Draw on the page">${ICONS.draw}</button>
				<span class="tip" aria-hidden="true">Draw</span>
			</span>
			<span class="wrap">
				<button class="tool" id="t-markers" type="button" aria-pressed="true" aria-label="Show pending-change markers on the page">${ICONS.eye}</button>
				<span class="tip" aria-hidden="true">Markers</span>
			</span>
			<span class="divider" aria-hidden="true"></span>
			<span class="wrap">
				<button class="status" id="status-toggle" type="button" aria-expanded="false" aria-label="Show build queue and activity">
					<span class="dot" id="dot"></span><span id="status-text">0</span>
				</button>
				<span class="tip" id="status-tip" aria-hidden="true">Build activity</span>
			</span>
			<span class="wrap">
				<button class="icon-btn" id="dock-close" type="button" aria-label="Hide the toolbar">${ICONS.close}</button>
				<span class="tip" aria-hidden="true">Hide</span>
			</span>
		</div>
	</div>
	<button class="handle" id="handle" type="button" hidden aria-label="Show the App Harness toolbar" data-edge="bottom"><span class="handle-line" aria-hidden="true"></span></button>
	<form class="composer" id="composer" hidden>
		<span class="context" id="context"></span>
		<div class="quote" id="quote" hidden></div>
		<textarea id="input" rows="2" aria-label="Describe the change"></textarea>
		<div class="actions">
			<button type="button" class="btn cancel" id="cancel">Cancel</button>
			<button type="submit" class="btn primary" id="submit" title="Submit (Cmd/Ctrl + Enter)">Submit</button>
		</div>
		<p class="msg" id="msg" role="status"></p>
	</form>
</div>`;

	const $ = (id) => root.getElementById(id);
	const drawLayer = $("draw"), hint = $("hint");
	const hoverBox = $("hover-box"), hoverChip = $("hover-chip"), chipPath = $("chip-path"), chipName = $("chip-name");
	const dockEl = $("dock"), pill = $("pill"), grip = $("grip"), dockClose = $("dock-close"), handle = $("handle");
	const panel = $("panel"), panelClose = $("panel-close"), panelSub = $("panel-sub"), queueEl = $("queue"), queueEmpty = $("queue-empty");
	const feedEl = $("feed"), feedEmpty = $("feed-empty"), harnessFeed = $("harness-feed"), harnessFeedLabel = $("harness-feed-label");
	const statusToggle = $("status-toggle"), statusText = $("status-text"), statusTip = $("status-tip"), dot = $("dot");
	const composer = $("composer"), context = $("context"), quote = $("quote"), input = $("input"), msg = $("msg");
	const submit = $("submit"), cancel = $("cancel");
	const markersEl = $("markers"), markersToggle = $("t-markers");
	const tools = { target: $("t-target"), comment: $("t-comment"), draw: $("t-draw") };

	function mount() {
		// On <html>, deliberately outside <body>: body carries the framed-mode
		// transform and the overlay must not scale with the page. Appending an
		// element to <html> is valid DOM and renders normally.
		(document.documentElement || document.body).append(host);
	}
	if (document.documentElement || document.body) mount();
	else document.addEventListener("DOMContentLoaded", mount, { once: true });

	// ---- Dock position, drag, close (persisted in the overlay's own key) -----

	// `placed` flips once the user positions the dock themselves; until then
	// the FIRST-RUN default applies: top center, open. `edge`/`along` describe
	// the closed state's flush edge tab.
	let dockState = { right: 20, bottom: 20, closed: false, markers: true, placed: false, edge: "bottom", along: 0 };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			// Stored coordinates mean the user placed the dock; their position
			// and open state always win over the first-run default.
			if (Number.isFinite(parsed.right)) { dockState.right = parsed.right; dockState.placed = true; }
			if (Number.isFinite(parsed.bottom)) { dockState.bottom = parsed.bottom; dockState.placed = true; }
			dockState.closed = parsed.closed === true;
			dockState.markers = parsed.markers !== false;
			if (parsed.edge === "top" || parsed.edge === "bottom" || parsed.edge === "left" || parsed.edge === "right") dockState.edge = parsed.edge;
			if (Number.isFinite(parsed.along)) dockState.along = parsed.along;
		}
	} catch { /* Private mode or a full store: the defaults are fine. */ }

	function saveDockState() {
		try { localStorage.setItem(STORAGE_KEY, JSON.stringify(dockState)); } catch { /* best-effort */ }
	}

	const HANDLE_LONG = 56, HANDLE_THICK = 18;

	/** Place the closed-state tab flush against its edge at its along-offset. */
	function applyHandlePlacement() {
		const edge = dockState.edge;
		handle.dataset.edge = edge;
		handle.style.left = ""; handle.style.right = ""; handle.style.top = ""; handle.style.bottom = "";
		const horizontal = edge === "top" || edge === "bottom";
		const max = (horizontal ? innerWidth : innerHeight) - HANDLE_LONG - 8;
		const along = Math.max(8, Math.min(Number.isFinite(dockState.along) ? dockState.along : max / 2, max));
		dockState.along = along;
		if (edge === "top") { handle.style.top = "0px"; handle.style.left = `${along}px`; }
		if (edge === "bottom") { handle.style.bottom = "0px"; handle.style.left = `${along}px`; }
		if (edge === "left") { handle.style.left = "0px"; handle.style.top = `${along}px`; }
		if (edge === "right") { handle.style.right = "0px"; handle.style.top = `${along}px`; }
	}

	function applyDockState() {
		const pillRect = pill.getBoundingClientRect();
		const pillWidth = pillRect.width || 300, pillHeight = pillRect.height || 44;
		// FIRST RUN: the toolbar presents itself top center, open — until the
		// user drags it somewhere, which persists and wins forever after.
		if (!dockState.placed) {
			dockState.right = Math.max(4, Math.round((innerWidth - pillWidth) / 2));
			dockState.bottom = Math.max(4, innerHeight - 20 - pillHeight);
		}
		const right = Math.max(4, Math.min(dockState.right, innerWidth - 48));
		const bottom = Math.max(4, Math.min(dockState.bottom, innerHeight - 48));
		dockState.right = right; dockState.bottom = bottom;
		const dockTop = innerHeight - bottom - pillHeight;
		const dockLeft = innerWidth - right - pillWidth;
		// POSITION-AWARE FLYOUT: a flex box grows away from its anchored edge,
		// so the dock anchors to whichever edges leave the panel the most room
		// and the panel opens toward available space — never off-screen. A pill
		// in the top half anchors by its top edge (panel opens downward); one
		// in the left half anchors by its left edge (panel grows rightward).
		const down = dockTop + pillHeight / 2 < innerHeight / 2;
		const start = dockLeft + pillWidth / 2 < innerWidth / 2;
		dockEl.classList.toggle("down", down);
		dockEl.classList.toggle("start", start);
		if (down) { dockEl.style.top = `${Math.max(4, dockTop)}px`; dockEl.style.bottom = "auto"; }
		else { dockEl.style.bottom = `${bottom}px`; dockEl.style.top = "auto"; }
		if (start) { dockEl.style.left = `${Math.max(4, dockLeft)}px`; dockEl.style.right = "auto"; }
		else { dockEl.style.right = `${right}px`; dockEl.style.left = "auto"; }
		if (dockState.closed) applyHandlePlacement();
		dockEl.hidden = dockState.closed;
		handle.hidden = !dockState.closed;
		// Never clipped: cap the panel by the space it actually has to open into.
		const room = down ? innerHeight - dockTop - pillHeight - 34 : dockTop - 14;
		panel.style.maxHeight = `${Math.max(160, Math.min(480, room))}px`;
		// Only the controls that are actually actuatable in the current state
		// participate in the tab order (agentation's dynamic tabIndex pattern).
		handle.tabIndex = dockState.closed ? 0 : -1;
		panelClose.tabIndex = panel.hidden ? -1 : 0;
		syncFrame();
		renderMarkers();
	}

	// WHOLE-toolbar drag with edge snapping: any pointerdown on the pill's
	// background (not its buttons) or the grip drags the dock; on release it
	// settles magnetically to a nearby edge or corner.
	const SNAP_DISTANCE = 24, SNAP_MARGIN = 20;
	let dragFrom = null;
	function beginDockDrag(event, surface) {
		dragFrom = { x: event.clientX, y: event.clientY, right: dockState.right, bottom: dockState.bottom };
		surface?.setPointerCapture?.(event.pointerId);
		event.preventDefault?.();
	}
	function moveDockDrag(event) {
		if (!dragFrom) return;
		// A drag whose pointerup was lost (released off-window, capture missing)
		// must not follow an unpressed pointer around.
		if (typeof event.buttons === "number" && event.buttons === 0) { endDockDrag(); return; }
		dockState.right = dragFrom.right - (event.clientX - dragFrom.x);
		dockState.bottom = dragFrom.bottom - (event.clientY - dragFrom.y);
		applyDockState();
	}
	function endDockDrag() {
		if (!dragFrom) return;
		dragFrom = null;
		// The user has placed the dock: the first-run default stands down.
		dockState.placed = true;
		// Magnetic settle: snap an edge that is within reach, animated briefly.
		const pillRect = pill.getBoundingClientRect();
		const width = pillRect.width || 300, height = pillRect.height || 44;
		let { right, bottom } = dockState;
		if (right < SNAP_DISTANCE + SNAP_MARGIN) right = SNAP_MARGIN;
		else if (innerWidth - right - width < SNAP_DISTANCE + SNAP_MARGIN) right = innerWidth - width - SNAP_MARGIN;
		if (bottom < SNAP_DISTANCE + SNAP_MARGIN) bottom = SNAP_MARGIN;
		else if (innerHeight - bottom - height < SNAP_DISTANCE + SNAP_MARGIN) bottom = innerHeight - height - SNAP_MARGIN;
		if (right !== dockState.right || bottom !== dockState.bottom) {
			dockEl.style.transition = "left 0.15s ease, top 0.15s ease, right 0.15s ease, bottom 0.15s ease";
			handle.style.transition = "right 0.15s ease, bottom 0.15s ease";
			setTimeout(() => { dockEl.style.transition = ""; handle.style.transition = ""; }, 180);
			dockState.right = right; dockState.bottom = bottom;
			applyDockState();
		}
		saveDockState();
	}
	grip.addEventListener("pointerdown", (event) => beginDockDrag(event, grip));
	// Agentation drags by the toolbar background; the pill's own empty area
	// works here too, while buttons keep their clicks.
	pill.addEventListener("pointerdown", (event) => { if (event.target === pill) beginDockDrag(event, pill); });
	grip.addEventListener("pointermove", moveDockDrag);
	pill.addEventListener("pointermove", moveDockDrag);
	grip.addEventListener("pointerup", endDockDrag);
	pill.addEventListener("pointerup", endDockDrag);
	grip.addEventListener("pointercancel", endDockDrag);
	pill.addEventListener("pointercancel", endDockDrag);
	// Keyboard operability for the drag (a deliberate addition beyond
	// agentation): the focused grip nudges the dock with the arrow keys.
	grip.addEventListener("keydown", (event) => {
		const step = event.shiftKey ? 32 : 8;
		const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
		const move = moves[event.key];
		if (!move) return;
		event.preventDefault();
		dockState.placed = true;
		dockState.right += move[0];
		dockState.bottom += move[1];
		applyDockState();
		saveDockState();
	});

	dockClose.addEventListener("click", () => {
		// Attach the closed tab flush to the NEAREST page edge from where the
		// pill sits right now, at the matching offset along that edge.
		const pillRect = pill.getBoundingClientRect();
		const pillWidth = pillRect.width || 300, pillHeight = pillRect.height || 44;
		const centerX = innerWidth - dockState.right - pillWidth / 2;
		const centerY = innerHeight - dockState.bottom - pillHeight / 2;
		const distances = { left: centerX, right: innerWidth - centerX, top: centerY, bottom: innerHeight - centerY };
		dockState.edge = Object.keys(distances).sort((a, b) => distances[a] - distances[b])[0];
		dockState.along = (dockState.edge === "top" || dockState.edge === "bottom" ? centerX : centerY) - HANDLE_LONG / 2;
		dockState.closed = true;
		hidePanel();
		clearMode();
		applyDockState();
		saveDockState();
		handle.focus?.();
	});

	// The closed tab drags ALONG its edge (and across to another edge,
	// snapping flush); a plain click jumps the toolbar back out at that spot.
	let handleDrag = null, handleDragMoved = false;
	handle.addEventListener("pointerdown", (event) => {
		handleDrag = { x: event.clientX, y: event.clientY };
		handleDragMoved = false;
		handle.setPointerCapture?.(event.pointerId);
		event.preventDefault?.();
	});
	handle.addEventListener("pointermove", (event) => {
		if (!handleDrag) return;
		if (typeof event.buttons === "number" && event.buttons === 0) { handleDrag = null; saveDockState(); return; }
		if (!handleDragMoved && Math.hypot(event.clientX - handleDrag.x, event.clientY - handleDrag.y) <= 4) return;
		handleDragMoved = true;
		const distances = { left: event.clientX, right: innerWidth - event.clientX, top: event.clientY, bottom: innerHeight - event.clientY };
		dockState.edge = Object.keys(distances).sort((a, b) => distances[a] - distances[b])[0];
		dockState.along = (dockState.edge === "top" || dockState.edge === "bottom" ? event.clientX : event.clientY) - HANDLE_LONG / 2;
		applyHandlePlacement();
	});
	function endHandleDrag() {
		if (!handleDrag) return;
		handleDrag = null;
		saveDockState();
	}
	handle.addEventListener("pointerup", endHandleDrag);
	handle.addEventListener("pointercancel", endHandleDrag);
	handle.addEventListener("click", () => {
		// A drag that just ended is not a click.
		if (handleDragMoved) { handleDragMoved = false; return; }
		// JUMP OUT: expand back to the full toolbar at the tab's location,
		// with agentation's springy pop.
		const pillRect = pill.getBoundingClientRect();
		const pillWidth = pillRect.width || 300, pillHeight = pillRect.height || 44;
		const alongCenter = dockState.along + HANDLE_LONG / 2;
		const MARGIN = 20;
		if (dockState.edge === "top" || dockState.edge === "bottom") {
			dockState.right = Math.max(4, Math.min(innerWidth - alongCenter - pillWidth / 2, innerWidth - pillWidth - 4));
			dockState.bottom = dockState.edge === "top" ? innerHeight - MARGIN - pillHeight : MARGIN;
		} else {
			dockState.bottom = Math.max(4, Math.min(innerHeight - alongCenter - pillHeight / 2, innerHeight - pillHeight - 4));
			dockState.right = dockState.edge === "left" ? innerWidth - MARGIN - pillWidth : MARGIN;
		}
		dockState.placed = true;
		dockState.closed = false;
		applyDockState();
		saveDockState();
		pill.classList.add("pop");
		setTimeout(() => pill.classList.remove("pop"), 320);
		tools.target.focus?.();
	});

	// ---- Framed mode ---------------------------------------------------------
	//
	// While the harness is OPEN (a tool armed, the panel open, or the composer
	// up) the page insets 8px on every side and floats, 12px-rounded, on a
	// slow flowing gradient. Implementation constraint: the no-reflow
	// invariant. transform:scale is paint-only — the app's layout metrics stay
	// byte-identical — and every inline property this writes is recorded first
	// and restored verbatim on exit. The gradient is painted as <html>'s own
	// background (which also stops the app's body background from propagating
	// to the canvas), so it survives arbitrary app restyling; its motion is a
	// rAF background-position walk because the overlay never injects
	// stylesheets into the host document.
	const FRAME_INSET = 8;
	const FRAME_RADIUS = 12;
	const FRAME_GRADIENT = "linear-gradient(130deg, #a5d8ff, #d0bfff, #fcc2d7, #ffe8a1, #b2f2bb, #a5d8ff)";
	const FRAME_HTML_PROPS = ["background", "background-size", "background-position"];
	// clip-path (not overflow/border-radius): rounding the page's corners via
	// clip-path is pure paint — overflow would change body's formatting
	// context and margin collapsing, which IS a reflow.
	const FRAME_BODY_PROPS = ["transform", "transform-origin", "transition", "clip-path", "will-change", "background-color"];
	const savedFrameStyles = { html: new Map(), body: new Map() };
	let framed = false, frameRestoreTimer = null, gradientFrame = null, gradientStartedAt = 0;

	function prefersReducedMotion() {
		try { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
	}

	function sizeFrame() {
		const body = document.body;
		if (!framed || !body) return;
		// A viewport that has not laid out yet must not produce a frame at all
		// — a transient absurd scale would then ANIMATE from that state, and a
		// throttled background tab can park a transition mid-flight for
		// minutes, leaving the page tiny. Skip until the viewport is real, and
		// clamp hard: the frame is only ever about a 1% inset.
		if (!(innerWidth >= 100) || !(innerHeight >= 100)) return;
		// Exact 8px inset on every side: per-axis scale about the center. The
		// axis factors differ by under a percent — imperceptible, exact inset.
		const sx = Math.min(1, Math.max(0.9, (innerWidth - FRAME_INSET * 2) / innerWidth));
		const sy = Math.min(1, Math.max(0.9, (innerHeight - FRAME_INSET * 2) / innerHeight));
		body.style.setProperty("transform", `scale(${sx.toFixed(5)}, ${sy.toFixed(5)})`);
		body.style.setProperty("clip-path", `inset(0 round ${FRAME_RADIUS}px)`);
	}

	function gradientTick() {
		if (!framed) return;
		const elapsed = (Date.now() - gradientStartedAt) / 30000; // one slow sweep ≈ 30s
		const position = (1 - Math.cos(elapsed * Math.PI * 2)) / 2 * 100;
		document.documentElement.style.setProperty("background-position", `${position.toFixed(2)}% 50%`);
		gradientFrame = requestAnimationFrame(gradientTick);
	}

	function enterFrame() {
		const html = document.documentElement, body = document.body;
		if (framed || !html || !body) return;
		framed = true;
		clearTimeout(frameRestoreTimer);
		for (const prop of FRAME_HTML_PROPS) savedFrameStyles.html.set(prop, html.style.getPropertyValue(prop));
		for (const prop of FRAME_BODY_PROPS) savedFrameStyles.body.set(prop, body.style.getPropertyValue(prop));
		// Many apps paint no background of their own and rely on <body>'s (or
		// the UA's) background propagating to the canvas. Painting the gradient
		// on <html> stops that propagation, which would leave the whole page
		// see-through onto the gradient instead of floating on it. So when the
		// body's computed background is fully transparent, give it the UA's
		// canvas color for the duration — `Canvas` follows the app's own
		// color-scheme, so a dark app stays dark and a light app stays light.
		let bodyBackground = "";
		try { bodyBackground = getComputedStyle(body).getPropertyValue("background-color"); } catch { bodyBackground = ""; }
		const transparent = !bodyBackground || bodyBackground === "transparent" || bodyBackground === "rgba(0, 0, 0, 0)";
		if (transparent) body.style.setProperty("background-color", "Canvas");
		html.style.setProperty("background", FRAME_GRADIENT);
		html.style.setProperty("background-size", "300% 300%");
		html.style.setProperty("background-position", "0% 50%");
		body.style.setProperty("transform-origin", "50% 50%");
		body.style.setProperty("will-change", "transform");
		// The FIRST frame applies instantly — enabling the transition only on
		// the next animation frame means nothing ever animates from the
		// unframed (or a half-initialized) state on load; the ~200ms ease
		// covers later changes (resize, exit) as designed.
		sizeFrame();
		if (!prefersReducedMotion()) {
			requestAnimationFrame(() => {
				if (framed) document.body?.style.setProperty("transition", "transform 0.2s ease, clip-path 0.2s ease");
			});
			gradientStartedAt = Date.now();
			gradientFrame = requestAnimationFrame(gradientTick);
		}
	}

	function exitFrame() {
		const html = document.documentElement, body = document.body;
		if (!framed || !html || !body) return;
		framed = false;
		if (gradientFrame !== null) { cancelAnimationFrame(gradientFrame); gradientFrame = null; }
		const restore = () => {
			for (const [prop, value] of savedFrameStyles.body) value ? body.style.setProperty(prop, value) : body.style.removeProperty(prop);
			for (const [prop, value] of savedFrameStyles.html) value ? html.style.setProperty(prop, value) : html.style.removeProperty(prop);
			savedFrameStyles.body.clear();
			savedFrameStyles.html.clear();
		};
		if (prefersReducedMotion()) { restore(); return; }
		// Ease back to full size, then restore every touched property verbatim.
		body.style.setProperty("transform", "scale(1)");
		body.style.setProperty("clip-path", "inset(0 round 0px)");
		frameRestoreTimer = setTimeout(restore, 240);
	}

	function syncFrame() {
		// The harness being OPEN is what frames the page (owner's ruling): the
		// toolbar showing means the app is visibly "held by the harness";
		// dismissing the dock to its handle releases the frame.
		if (!dockState.closed) enterFrame(); else exitFrame();
	}

	addEventListener("resize", () => { applyDockState(); sizeFrame(); });

	// ---- State ---------------------------------------------------------------

	let socket = null, reconnectTimer = null, connected = false;
	let mode = null, selected = null, selectedEnvelope = null, pendingDraw = null;
	let drawing = false, draftPoints = [], draftPath = null;
	let optimistic = 0, chipsState = [];
	let composerInvoker = null;
	const pending = new Map();
	const renderedFeed = new Set();
	// The overlay marks the app's DOM with ONE attribute while targeting, and
	// removes it on clear. It is visual-only and never persists past a
	// selection.
	const HILITE = "data-app-harness-hilite";

	function setHint(text, kbd) {
		hint.replaceChildren();
		if (text) {
			const label = document.createElement("span");
			label.textContent = text;
			hint.append(label);
			if (kbd) {
				const key = document.createElement("span");
				key.className = "kbd";
				key.textContent = kbd;
				hint.append(key);
			}
		}
		hint.hidden = !text;
	}

	// ---- Page cursor while armed --------------------------------------------
	// Crosshair over the PAGE only: the overlay's own chrome states its own
	// cursors (default on surfaces, pointer on controls) inside the shadow
	// root, so the armed-mode cursor never leaks onto the toolbar.
	let savedPageCursor = null;
	function setPageCursor(value) {
		const html = document.documentElement;
		if (!html) return;
		if (value) {
			if (savedPageCursor === null) savedPageCursor = html.style.getPropertyValue("cursor");
			html.style.setProperty("cursor", value);
		} else if (savedPageCursor !== null) {
			savedPageCursor ? html.style.setProperty("cursor", savedPageCursor) : html.style.removeProperty("cursor");
			savedPageCursor = null;
		}
	}

	// ---- Hover preview (agentation's deepElementFromPoint + highlight) -------

	/** Pierce open shadow roots to the deepest element at a point. */
	function deepElementFromPoint(x, y) {
		let element = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
		let guard = 0;
		while (element && element.shadowRoot && typeof element.shadowRoot.elementFromPoint === "function" && guard < 20) {
			const deeper = element.shadowRoot.elementFromPoint(x, y);
			if (!deeper || deeper === element) break;
			element = deeper;
			guard += 1;
		}
		return element;
	}

	/** True when the node belongs to the overlay rather than the app (crosses shadow boundaries, agentation's closestCrossingShadow). */
	function overlayOwns(node) {
		let current = node;
		let guard = 0;
		while (current && guard < 200) {
			if (current === host) return true;
			current = current.parentElement
				|| (current.host ?? null)
				|| (current.parentNode && current.parentNode.host ? current.parentNode.host : null);
			guard += 1;
		}
		return false;
	}

	let hoverEl = null, hoverIsHarness = false;

	function restartAnimation(element) {
		element.classList.remove("enter");
		// Force a style flush so re-adding the class restarts the animation.
		element.getBoundingClientRect();
		element.classList.add("enter");
	}

	function positionChip(x, y) {
		hoverChip.style.left = `${Math.max(8, Math.min(x + 12, innerWidth - 120))}px`;
		hoverChip.style.top = `${Math.max(8, y - 44)}px`;
	}

	function syncHoverBox() {
		if (!hoverEl) return;
		const rect = hoverEl.getBoundingClientRect();
		hoverBox.style.left = `${rect.left}px`;
		hoverBox.style.top = `${rect.top}px`;
		hoverBox.style.width = `${rect.width}px`;
		hoverBox.style.height = `${rect.height}px`;
	}

	function setHover(element, x, y, harness = false) {
		if (!element) {
			hoverEl = null;
			hoverIsHarness = false;
			hoverBox.hidden = true;
			hoverChip.hidden = true;
			return;
		}
		const changed = element !== hoverEl;
		hoverEl = element;
		hoverIsHarness = harness;
		hoverBox.classList.toggle("harness", harness);
		hoverChip.classList.toggle("harness", harness);
		hoverBox.hidden = false;
		hoverChip.hidden = false;
		syncHoverBox();
		positionChip(x, y);
		if (changed) {
			if (harness) {
				chipPath.textContent = readablePath(element, 3);
				chipName.textContent = "App Harness UI · ⌥-click to give feedback";
			} else {
				const dataLoc = element.getAttribute?.("data-loc") || element.closest?.("[data-loc]")?.getAttribute("data-loc") || null;
				chipPath.textContent = readablePath(element);
				chipName.textContent = dataLoc ? `${describeTarget(element)} · ${dataLoc}` : describeTarget(element);
			}
			restartAnimation(hoverBox);
			restartAnimation(hoverChip);
		}
	}

	document.addEventListener("mousemove", (event) => {
		if (mode !== "target" && mode !== "comment") return;
		if (!composer.hidden) return;
		const raw = (typeof event.composedPath === "function" ? event.composedPath()[0] : null) || event.target;
		// The root-level listener below previews the harness's own chrome; the
		// document sees only the closed host, so it must not clobber that.
		if (raw && overlayOwns(raw)) { if (!hoverIsHarness) setHover(null); return; }
		const element = deepElementFromPoint(event.clientX, event.clientY);
		if (!element || overlayOwns(element)) { setHover(null); return; }
		setHover(element, event.clientX, event.clientY);
	});

	// SELF-ANNOTATION (harness feedback). While a tool is armed, the harness's
	// own chrome becomes annotatable too — in a visibly different style — and
	// ⌥-click opens the composer in harness-feedback mode. These submissions
	// NEVER dispatch a build: the platform is firewalled from the room's
	// agents, so the fact is recorded for the harness team instead.
	root.addEventListener("mousemove", (event) => {
		if (mode !== "target" && mode !== "comment") return;
		if (!composer.hidden) return;
		const target = event.target;
		if (!target || !target.tagName || target === hoverBox || target === hoverChip) return;
		setHover(target, event.clientX ?? 0, event.clientY ?? 0, true);
	});

	function harnessEnvelope(element) {
		return {
			kind: "harness-feedback",
			label: element.getAttribute?.("aria-label") || describeTarget(element),
			selectorPath: readablePath(element, 4),
			control: element.getAttribute?.("id") || null,
		};
	}

	root.addEventListener("click", (event) => {
		if (!event.altKey) return;
		if (mode !== "target" && mode !== "comment") return;
		const element = event.target;
		if (!element || !element.tagName) return;
		event.preventDefault?.();
		event.stopPropagation?.();
		event.stopImmediatePropagation?.();
		clearSelection();
		selectedEnvelope = harnessEnvelope(element);
		composerInvoker = tools[mode] ?? null;
		clearMode();
		openComposer("harness-feedback", `Harness UI: ${selectedEnvelope.label}`, { x: event.clientX ?? 0, y: event.clientY ?? 0 });
	}, true);
	// The highlight and the intent markers track their elements through
	// scroll and resize, like agentation's live-tracked boxes.
	addEventListener("scroll", () => { if (hoverEl) syncHoverBox(); renderMarkers(); }, true);
	addEventListener("resize", () => { if (hoverEl) syncHoverBox(); renderMarkers(); });

	function clearSelection() {
		if (selected) selected.removeAttribute(HILITE);
		selected = null; selectedEnvelope = null; pendingDraw = null;
	}

	function setMode(next) {
		mode = mode === next ? null : next;
		for (const [name, button] of Object.entries(tools)) button.setAttribute("aria-pressed", String(mode === name));
		drawLayer.classList.toggle("active", mode === "draw");
		setPageCursor(mode === "target" || mode === "comment" ? "crosshair" : null);
		if (mode !== "target" && mode !== "comment") setHover(null);
		setHint(mode === "target" ? "Click any element to request a change"
			: mode === "comment" ? "Click any element to comment"
			: mode === "draw" ? "Draw to annotate an area" : "", mode ? "esc" : "");
		if (mode === null) clearSelection(); else closeComposer(false);
		syncFrame();
	}
	function clearMode() {
		mode = null;
		for (const button of Object.values(tools)) button.setAttribute("aria-pressed", "false");
		drawLayer.classList.remove("active");
		setPageCursor(null);
		setHover(null);
		setHint("");
		syncFrame();
	}

	function positionComposer(anchor) {
		composer.style.left = "0px"; composer.style.top = "0px";
		const rect = composer.getBoundingClientRect();
		let left = anchor.x + GUTTER, top = anchor.y + GUTTER;
		if (left + rect.width > innerWidth - GUTTER) left = anchor.x - rect.width - GUTTER;
		if (top + rect.height > innerHeight - GUTTER) top = anchor.y - rect.height - GUTTER;
		composer.style.left = `${Math.max(GUTTER, Math.min(left, innerWidth - rect.width - GUTTER))}px`;
		composer.style.top = `${Math.max(GUTTER, Math.min(top, innerHeight - rect.height - GUTTER))}px`;
	}

	function openComposer(kind, label, anchor) {
		composer.dataset.kind = kind;
		context.textContent = label;
		// Selected text rides visibly (agentation's quote): "change THIS phrase".
		const picked = selectedEnvelope?.selectedText;
		quote.textContent = picked ? `“${picked}”` : "";
		quote.hidden = !picked;
		input.value = "";
		input.placeholder = kind === "comment" ? "Leave feedback…" : kind === "harness-feedback" ? "What should the harness do better?" : "Request a change…";
		msg.textContent = ""; msg.classList.remove("ok");
		submit.disabled = false; composer.hidden = false;
		positionComposer(anchor);
		setHover(null);
		input.focus();
		syncFrame();
	}

	function closeComposer(clear = true) {
		const wasOpen = !composer.hidden;
		composer.hidden = true;
		if (clear) clearSelection();
		// Focus returns to the control that started the flow (agentation's
		// popup contract), so keyboard users are never dropped on <body>.
		if (wasOpen && composerInvoker) { composerInvoker.focus?.(); composerInvoker = null; }
		syncFrame();
	}

	// Capture-phase, so the app never sees the click that selects an element.
	document.addEventListener("click", (event) => {
		if (mode !== "target" && mode !== "comment") return;
		const raw = (typeof event.composedPath === "function" ? event.composedPath()[0] : null) || event.target;
		if (raw && overlayOwns(raw)) return;
		// Prefer the live hover preview's element — it is exactly what the
		// highlight told the user they were about to pick — then fall back to
		// a fresh hit-test at the click point.
		const element = (hoverEl && !overlayOwns(hoverEl) ? hoverEl : null)
			|| deepElementFromPoint(event.clientX, event.clientY)
			|| (raw && raw.tagName && !overlayOwns(raw) ? raw : null);
		if (!element || !element.tagName || typeof element.getBoundingClientRect !== "function") return;
		event.preventDefault?.();
		event.stopImmediatePropagation?.();
		clearSelection();
		selected = element;
		element.setAttribute(HILITE, "");
		selectedEnvelope = captureEnvelope(element);
		// Text selection makes the request exact (agentation's selectedText):
		// the envelope carries the selected string alongside the element anchor.
		try {
			const selection = typeof getSelection === "function" ? getSelection() : null;
			const picked = selection && !selection.isCollapsed ? String(selection).trim() : "";
			if (picked.length) selectedEnvelope.selectedText = picked.slice(0, 500);
		} catch { /* Selection access is best-effort. */ }
		const kind = mode;
		composerInvoker = tools[kind] ?? null;
		clearMode();
		openComposer(kind, `${kind === "comment" ? "Comment on" : "Target"}: ${selectedEnvelope.label}`, { x: event.clientX, y: event.clientY });
	}, true);

	const pathFor = (points) => points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");

	drawLayer.addEventListener("pointermove", (event) => {
		// The draw-mode affordance: the same chip, telling the user what a drag
		// will do, following the crosshair.
		if (mode !== "draw" || drawing) return;
		chipPath.textContent = "";
		chipName.textContent = "Draw to annotate an area";
		hoverChip.hidden = false;
		positionChip(event.clientX, event.clientY);
	});

	drawLayer.addEventListener("pointerdown", (event) => {
		if (mode !== "draw") return;
		event.preventDefault();
		drawing = true;
		hoverChip.hidden = true;
		draftPoints = [{ x: Math.round(event.clientX), y: Math.round(event.clientY) }];
		draftPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
		drawLayer.append(draftPath);
		drawLayer.setPointerCapture?.(event.pointerId);
	});
	drawLayer.addEventListener("pointermove", (event) => {
		if (!drawing) return;
		const point = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
		const previous = draftPoints[draftPoints.length - 1];
		if (Math.hypot(point.x - previous.x, point.y - previous.y) < MIN_DRAW_DISTANCE) return;
		draftPoints.push(point);
		draftPath.setAttribute("d", pathFor(draftPoints));
	});
	function finishDraw(event) {
		if (!drawing) return;
		drawing = false;
		drawLayer.releasePointerCapture?.(event.pointerId);
		if (draftPoints.length < 2) { draftPath?.remove(); draftPath = null; return; }
		// Hit-test the app UNDER the overlay: the draw layer stops capturing
		// first, so elementFromPoint returns the app's element.
		drawLayer.classList.remove("active");
		const under = deepElementFromPoint(draftPoints[0].x, draftPoints[0].y);
		const target = under && !overlayOwns(under) ? under : document.body;
		pendingDraw = { points: draftPoints.slice(0, 600), envelope: captureEnvelope(target), path: draftPath };
		draftPath = null;
		composerInvoker = tools.draw;
		clearMode();
		openComposer("draw", `Drawing over: ${pendingDraw.envelope.label}`, draftPoints[draftPoints.length - 1]);
	}
	drawLayer.addEventListener("pointerup", finishDraw);
	drawLayer.addEventListener("pointercancel", finishDraw);

	// ---- Submission ----------------------------------------------------------

	composer.addEventListener("submit", (event) => {
		event.preventDefault();
		const kind = composer.dataset.kind;
		const text = input.value.trim();
		if (kind !== "draw" && !text.length) {
			msg.textContent = kind === "comment" ? "Write a brief comment." : "Describe the change you want.";
			return;
		}
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			msg.textContent = "Not connected yet.";
			return;
		}
		if (kind === "harness-feedback") {
			// Never a build: recorded for the harness team, outside the room's
			// own pipeline, so it does not touch the optimistic active count.
			send({ type: "harness:feedback", text, annotation: selectedEnvelope, clientSubmissionId: crypto.randomUUID() });
			submit.disabled = true; msg.classList.remove("ok"); msg.textContent = "Sending…";
			return;
		}
		let annotation;
		if (kind === "draw") {
			if (!pendingDraw) { msg.textContent = "Draw something first."; return; }
			annotation = { kind: "draw", ...pendingDraw.envelope, drawingPoints: pendingDraw.points };
		} else if (kind === "comment") {
			annotation = { kind: "comment", ...selectedEnvelope, text };
		} else {
			annotation = { kind: "target", ...selectedEnvelope };
		}
		send({ type: `request:${kind}`, text, annotation, clientSubmissionId: crypto.randomUUID() });
		optimistic += 1; updateStatus();
		submit.disabled = true; msg.classList.remove("ok"); msg.textContent = "Submitting…";
	});

	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			if (!submit.disabled) composer.requestSubmit();
		}
	});
	cancel.addEventListener("click", () => { pendingDraw?.path?.remove(); closeComposer(); });

	// Escape peels exactly ONE layer per press, innermost first (agentation's
	// ordering): composer → in-progress stroke → armed mode → open panel.
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		if (!composer.hidden) {
			pendingDraw?.path?.remove();
			closeComposer();
			return;
		}
		if (drawing) {
			// Abandon an in-progress draw: without this, the pointer capture
			// still delivers the eventual pointerup to finishDraw, which
			// reopens the composer for the stroke the user just cancelled.
			drawing = false; draftPath?.remove(); draftPath = null; draftPoints = [];
			return;
		}
		if (mode !== null) {
			clearMode();
			clearSelection();
			return;
		}
		if (!panel.hidden) {
			hidePanel();
			statusToggle.focus?.();
		}
	});
	for (const [name, button] of Object.entries(tools)) button.addEventListener("click", () => setMode(name));

	function showPanel() {
		panel.hidden = false;
		statusToggle.setAttribute("aria-expanded", "true");
		panelClose.tabIndex = 0;
		syncFrame();
	}
	function hidePanel() {
		panel.hidden = true;
		statusToggle.setAttribute("aria-expanded", "false");
		panelClose.tabIndex = -1;
		syncFrame();
	}
	statusToggle.addEventListener("click", () => { panel.hidden ? showPanel() : hidePanel(); });
	panelClose.addEventListener("click", () => { hidePanel(); statusToggle.focus?.(); });

	// ---- Status / queue / feed (projection of durable facts only) -----------

	function activeCount() {
		// Chips are the platform's truth: one per intent, from acceptance to
		// its terminal fact. Locally pending acks fill the sub-second gap
		// before the ack's own chip arrives, deduped by intent id.
		const chipIntents = new Set(chipsState.map((chip) => chip.intentId));
		let waiting = 0;
		for (const intentId of pending.keys()) if (!chipIntents.has(intentId)) waiting += 1;
		return chipsState.length + waiting + optimistic;
	}

	/** "2 building · 1 verifying" — the words live in the tooltip and aria, not the dock. */
	function pipelinePhrase(count) {
		if (count === 0) return "Build activity";
		const order = ["building", "verifying", "deploying", "queued", "accepted", "reviewing"];
		const groups = new Map();
		for (const chip of chipsState) groups.set(chip.phase, (groups.get(chip.phase) ?? 0) + 1);
		const parts = order.filter((phase) => groups.has(phase)).map((phase) => `${groups.get(phase)} ${phase}`);
		const extra = count - chipsState.length;
		if (extra > 0) parts.push(`${extra} sending`);
		return parts.join(" · ") || `${count} active`;
	}

	function updateStatus() {
		const count = activeCount();
		// TERSE by design: the number carries the load, the dot's color carries
		// the leading phase. Words live in the tooltip and the panel.
		statusText.textContent = String(count);
		const phased = chipsState.find((chip) => chip.phase === "building" || chip.phase === "verifying" || chip.phase === "deploying") ?? chipsState[0];
		dot.className = `dot${count > 0 ? " busy" : connected ? " live" : ""}`;
		if (count > 0 && phased && phased.phase) dot.dataset.phase = phased.phase;
		else delete dot.dataset.phase;
		const phrase = pipelinePhrase(count);
		statusTip.textContent = phrase;
		statusToggle.setAttribute("aria-label", count > 0 ? `Build queue and activity: ${phrase}` : "Show build queue and activity");
		panelSub.textContent = connected ? (count > 0 ? phrase : "Idle · connected") : "Reconnecting…";
	}

	function renderQueue(chips) {
		queueEl.replaceChildren();
		chipsState = Array.isArray(chips) ? chips : [];
		for (const chip of chipsState) {
			// The platform's chip is now the whole pipeline truth; a chip that
			// arrives means any local pending entry for it is superseded.
			if (chip.intentId) pending.delete(chip.intentId);
			// One scannable line per item: phase dot, the quoted request, then
			// who asked and where it stands. The full request rides as a title.
			const row = document.createElement("div");
			row.className = "queue-item";
			if (chip.intentId) row.dataset.intent = chip.intentId;
			const d = document.createElement("span");
			d.className = "phase-dot";
			if (chip.phase) d.dataset.phase = chip.phase;
			const req = document.createElement("span");
			req.className = "req";
			req.textContent = typeof chip.text === "string" && chip.text.length ? `“${chip.text}”` : chip.label;
			if (typeof chip.text === "string" && chip.text.length) row.title = chip.text;
			const meta = document.createElement("span");
			meta.className = "meta";
			const stand = chip.phase === "queued" ? chip.label : chip.phase ?? "";
			meta.textContent = [chip.by, stand].filter(Boolean).join(" · ");
			row.append(d, req, meta);
			queueEl.append(row);
		}
		queueEmpty.hidden = chipsState.length > 0;
		renderMarkers();
		updateStatus();
	}

	// ---- Intent markers (agentation's annotation markers, mapped onto our
	// domain: one numbered pin per pending intent, on the element it targets,
	// colored by phase, retiring with the intent's terminal fact) ------------

	let markersOn = dockState.markers !== false;
	const markerNodes = new Map();

	function resolveAnchor(anchor) {
		if (!anchor || typeof anchor !== "object") return null;
		const dataLoc = typeof anchor.dataLoc === "string" ? anchor.dataLoc : "";
		if (dataLoc && !dataLoc.startsWith("dom:")) {
			try {
				const element = document.querySelector(`[data-loc="${dataLoc.replaceAll('"', '\\"')}"]`);
				if (element && !overlayOwns(element)) return element;
			} catch { /* fall through to the structural selector */ }
		}
		const selector = (typeof anchor.selector === "string" && anchor.selector) || (dataLoc.startsWith("dom:") ? dataLoc.slice(4) : "");
		if (selector) {
			try {
				const element = document.querySelector(selector);
				if (element && !overlayOwns(element)) return element;
			} catch { /* an unresolvable anchor simply has no pin */ }
		}
		return null;
	}

	function flashQueueRow(intentId) {
		for (const row of queueEl.children) {
			row.classList.toggle("flash", row.dataset.intent === intentId);
			if (row.dataset.intent === intentId) setTimeout(() => row.classList.remove("flash"), 1600);
		}
	}

	function renderMarkers() {
		const wanted = new Map();
		if (markersOn && !dockState.closed) {
			chipsState.forEach((chip, index) => {
				if (!chip.intentId) return;
				const element = resolveAnchor(chip.anchor);
				if (!element) return;
				wanted.set(chip.intentId, { chip, element, number: chip.position ?? index + 1 });
			});
		}
		for (const [intentId, node] of markerNodes) {
			if (wanted.has(intentId)) continue;
			markerNodes.delete(intentId);
			node.classList.remove("enter");
			node.classList.add("exit");
			setTimeout(() => node.remove(), 200);
		}
		for (const [intentId, info] of wanted) {
			let node = markerNodes.get(intentId);
			if (!node) {
				node = document.createElement("button");
				node.type = "button";
				node.className = "marker enter";
				node.addEventListener("click", () => { showPanel(); flashQueueRow(intentId); });
				markerNodes.set(intentId, node);
				markersEl.append(node);
			}
			node.dataset.phase = info.chip.phase ?? "";
			node.textContent = String(info.number);
			const described = typeof info.chip.text === "string" && info.chip.text.length ? `: “${info.chip.text}”` : "";
			node.setAttribute("aria-label", `Pending change ${info.number} (${info.chip.phase ?? "active"})${described}`);
			if (described) node.title = info.chip.text;
			const rect = info.element.getBoundingClientRect();
			node.style.left = `${Math.max(2, rect.right - 12)}px`;
			node.style.top = `${Math.max(2, rect.top - 12)}px`;
		}
	}

	markersToggle.addEventListener("click", () => {
		markersOn = !markersOn;
		dockState.markers = markersOn;
		markersToggle.setAttribute("aria-pressed", String(markersOn));
		saveDockState();
		renderMarkers();
	});

	function provenance(refs) {
		const wrap = document.createElement("span");
		wrap.className = "prov";
		if (!config.repoUrl) return null;
		if (Number.isInteger(refs.prNumber)) {
			const a = document.createElement("a");
			a.href = `${config.repoUrl}/pull/${refs.prNumber}`;
			a.target = "_blank"; a.rel = "noreferrer noopener";
			a.textContent = `PR #${refs.prNumber}`;
			wrap.append(a);
		}
		if (typeof refs.sha === "string" && refs.sha.length >= 7) {
			const a = document.createElement("a");
			a.href = `${config.repoUrl}/commit/${refs.sha}`;
			a.target = "_blank"; a.rel = "noreferrer noopener";
			a.textContent = refs.sha.slice(0, 7);
			wrap.append(a);
		}
		return wrap.childNodes.length ? wrap : null;
	}

	function addFeed(items) {
		for (const item of items || []) {
			if (renderedFeed.has(item.seq)) continue;
			renderedFeed.add(item.seq);
			const li = document.createElement("li");
			li.className = `kind-${item.kind}`;
			li.dataset.seq = String(item.seq);
			const text = document.createElement("span");
			text.textContent = item.text;
			li.append(text);
			const links = item.refs ? provenance(item.refs) : null;
			if (links) li.append(links);
			// Harness feedback lives in its own small section; everything else
			// is build activity. Newest first in both.
			const lane = item.kind === "harness-feedback" ? harnessFeed : feedEl;
			const before = [...lane.children].find((child) => Number(child.dataset.seq) < Number(item.seq));
			lane.insertBefore(li, before ?? null);
		}
		feedEmpty.hidden = feedEl.children.length > 0;
		harnessFeedLabel.hidden = harnessFeed.children.length === 0;
	}

	// ---- Transport -----------------------------------------------------------

	function send(payload) {
		if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
	}

	function connect() {
		clearTimeout(reconnectTimer);
		const base = config.apiBase || `${location.protocol}//${location.host}`;
		const url = new URL(`/api/rooms/${config.room}`, base);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		try { socket = new WebSocket(url.toString()); } catch { reconnectTimer = setTimeout(connect, 3000); return; }
		socket.addEventListener("open", () => { connected = true; updateStatus(); });
		socket.addEventListener("close", () => { connected = false; updateStatus(); reconnectTimer = setTimeout(connect, 1500); });
		socket.addEventListener("error", () => socket.close());
		socket.addEventListener("message", ({ data }) => {
			let event;
			try { event = JSON.parse(data); } catch { return; }
			if (event.type === "room:snapshot" && event.feed) { addFeed(event.feed.items); renderQueue(event.feed.queue); }
			if (event.type === "feed:update") { renderQueue(event.queue); addFeed(event.items); }
			if (event.type === "feed:history") addFeed(event.items);
			if (event.type === "request:ack") {
				optimistic = Math.max(0, optimistic - 1);
				pending.set(event.intentId, { cancelDeadline: event.cancelDeadline });
				pendingDraw?.path?.remove();
				msg.classList.add("ok");
				msg.textContent = "Accepted — watch the activity panel.";
				submit.disabled = false;
				setTimeout(() => closeComposer(), 1600);
				renderPending();
			}
			if (event.type === "harness:ack") {
				msg.classList.add("ok");
				msg.textContent = "Recorded — the harness improves outside this room's pipeline.";
				submit.disabled = false;
				setTimeout(() => closeComposer(), 1600);
			}
			if (event.type === "room:notice") {
				if (!composer.hidden) {
					if (submit.disabled) { optimistic = Math.max(0, optimistic - 1); updateStatus(); }
					msg.classList.remove("ok");
					msg.textContent = event.text;
					submit.disabled = false;
				}
			}
		});
	}

	function renderPending() {
		const now = Date.now();
		for (const [intentId, ack] of pending) if (ack.cancelDeadline <= now) pending.delete(intentId);
		updateStatus();
		if (pending.size) setTimeout(renderPending, 500);
	}

	// The overlay needs a session exactly like any room client does. It never
	// creates one: if the app has no session yet, the app's own join flow does
	// that, and the overlay simply connects once one exists.
	function start() {
		fetch(new URL("/api/session", config.apiBase || location.origin).toString(), { credentials: "same-origin" })
			.then((response) => { if (response.ok) connect(); else setTimeout(start, 4000); })
			.catch(() => setTimeout(start, 4000));
	}
	markersToggle.setAttribute("aria-pressed", String(dockState.markers !== false));
	applyDockState();
	start();
	updateStatus();
})();
