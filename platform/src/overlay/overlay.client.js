/**
 * THE APP HARNESS OVERLAY — platform-owned, frozen, agent-unmodifiable.
 *
 * This script attaches the authoring tools and the status surface (build
 * queue, activity feed, per-item provenance) to an app it knows NOTHING
 * about. It is the drop-in layer `npx app-harness init` installs into a
 * third-party application.
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
 * The overlay reads the app's DOM (to hit-test what a requester points at)
 * but never writes to it, and never depends on its structure: anchoring
 * degrades from data-loc refs to structural selectors automatically.
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
	window.__appHarnessOverlay = { version: 1 };

	const MAX_SNAPSHOT_CHARS = 4000;
	const STYLE_KEYS = ["color", "background-color", "font-size", "font-weight", "padding", "margin", "border", "border-radius", "display"];
	const MIN_DRAW_DISTANCE = 3;
	const GUTTER = 12;
	const STABLE_ATTRIBUTES = ["data-testid", "data-test", "data-qa", "data-component", "id", "name", "aria-label", "role"];
	const MAX_SELECTOR_DEPTH = 5;
	const UNSTABLE_CLASS = /^(?:[a-z]+-)?[a-f0-9]{5,}$|^css-|^sc-|^jsx-|^_[A-Za-z0-9]{4,}|^ng-|^svelte-/u;

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

	function describeTarget(element) {
		const attribute = stableAttribute(element);
		if (attribute && attribute.name !== "role") return `${attribute.name}="${attribute.value}"`;
		const text = typeof element?.textContent === "string" ? element.textContent.trim().replaceAll(/\s+/gu, " ") : "";
		if (text) return `“${text.length > 48 ? `${text.slice(0, 47)}…` : text}”`;
		return String(element?.tagName || "element").toLowerCase();
	}

	/**
	 * The annotation envelope. `dataLoc` is present only when the app opted
	 * into stamping; `selector` and `domSnapshot` are ALWAYS present, and are
	 * what make this work against an app with no build cooperation at all.
	 */
	function captureEnvelope(element) {
		const rect = element.getBoundingClientRect();
		const computed = getComputedStyle(element);
		const computedStyles = {};
		for (const key of STYLE_KEYS) computedStyles[key] = computed.getPropertyValue(key);
		const structural = structuralSelector(element);
		const dataLoc = element.getAttribute?.("data-loc") || element.closest?.("[data-loc]")?.getAttribute("data-loc") || null;
		return {
			// The ledger requires a non-empty dataLoc; the structural selector is
			// the honest stand-in when the app does not stamp its source.
			dataLoc: dataLoc || (structural ? `dom:${structural.selector}` : `dom:${String(element.tagName || "node").toLowerCase()}`),
			anchorMode: dataLoc ? "data-loc" : "structural",
			selector: structural ? structural.selector : null,
			selectorUnique: structural ? structural.unique : false,
			label: describeTarget(element),
			domSnapshot: element.outerHTML.slice(0, MAX_SNAPSHOT_CHARS),
			tag: String(element.tagName || "").toLowerCase(),
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
	host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
	// A CLOSED root: the app cannot reach in via host.shadowRoot.
	const root = host.attachShadow({ mode: "closed" });

	root.innerHTML = `
<style>
	:host, * { box-sizing: border-box; }
	/* Every value is stated explicitly: nothing is inherited from the app. */
	.layer {
		position: fixed; inset: 0; pointer-events: none;
		font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
		font-size: 13px; line-height: 1.45; font-weight: 400; font-style: normal;
		letter-spacing: normal; text-transform: none; text-align: left;
		color: #e8eaed; direction: ltr;
		color-scheme: dark;
	}
	.draw { position: fixed; inset: 0; pointer-events: none; }
	.draw.active { pointer-events: auto; cursor: crosshair; }
	.draw path { fill: none; stroke: #7cc4ff; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }

	.dock {
		position: fixed; right: 16px; bottom: 16px; pointer-events: auto;
		display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
		max-height: calc(100vh - 32px);
	}
	.pill {
		display: flex; align-items: center; gap: 4px; padding: 5px;
		background: #1f2023; border: 1px solid #35373b; border-radius: 999px;
		box-shadow: 0 6px 24px rgba(0,0,0,.38);
	}
	.tool {
		appearance: none; border: 0; background: transparent; color: #c9ccd1;
		font: inherit; font-size: 12px; padding: 6px 11px; border-radius: 999px;
		cursor: pointer; white-space: nowrap;
	}
	.tool:hover { background: #2b2d31; color: #fff; }
	.tool[aria-pressed="true"] { background: #3b82f6; color: #fff; }
	.tool:focus-visible { outline: 2px solid #7cc4ff; outline-offset: 1px; }
	.status {
		display: flex; align-items: center; gap: 6px; padding: 6px 11px;
		border-radius: 999px; cursor: pointer; background: transparent;
		border: 0; color: #c9ccd1; font: inherit; font-size: 12px;
		border-left: 1px solid #35373b; margin-left: 2px;
	}
	.status:hover { background: #2b2d31; color: #fff; }
	.dot { width: 7px; height: 7px; border-radius: 50%; background: #4b5563; flex: none; }
	.dot.busy { background: #f59e0b; animation: pulse 1.6s ease-in-out infinite; }
	.dot.live { background: #22c55e; }
	@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
	@media (prefers-reduced-motion: reduce) { .dot.busy { animation: none; } }

	.panel {
		width: min(30rem, calc(100vw - 32px)); max-height: min(32rem, calc(100vh - 96px));
		display: flex; flex-direction: column; overflow: hidden;
		background: #1f2023; border: 1px solid #35373b; border-radius: 12px;
		box-shadow: 0 16px 48px rgba(0,0,0,.5);
	}
	.panel[hidden] { display: none !important; }
	.panel-head {
		display: flex; align-items: center; justify-content: space-between; gap: 8px;
		padding: 10px 12px; border-bottom: 1px solid #303236; flex: none;
	}
	.panel-title { font-size: 12px; font-weight: 600; color: #fff; letter-spacing: .01em; }
	.panel-sub { font-size: 11px; color: #9aa0a6; }
	.close {
		appearance: none; border: 0; background: transparent; color: #9aa0a6;
		font: inherit; font-size: 16px; line-height: 1; cursor: pointer; padding: 4px 6px; border-radius: 6px;
	}
	.close:hover { background: #2b2d31; color: #fff; }
	.panel-body { overflow-y: auto; overscroll-behavior: contain; padding: 4px 0 8px; }
	.section-label {
		font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: #7f858c;
		padding: 10px 12px 5px; font-weight: 600;
	}
	.queue { display: flex; flex-direction: column; gap: 5px; padding: 0 12px 4px; }
	.queue-item {
		display: flex; align-items: center; gap: 8px; padding: 7px 9px;
		background: #26282c; border: 1px solid #303236; border-radius: 7px; font-size: 12px; color: #d6d9dd;
	}
	.queue-empty, .feed-empty { padding: 4px 12px 8px; font-size: 12px; color: #7f858c; }
	.feed { list-style: none; margin: 0; padding: 0 12px; display: flex; flex-direction: column; }
	.feed li {
		padding: 7px 0; border-bottom: 1px solid #2a2c30; font-size: 12px; color: #c9ccd1;
		display: flex; flex-direction: column; gap: 3px;
	}
	.feed li:last-child { border-bottom: 0; }
	.feed .kind-run-failed, .feed .kind-run-parked, .feed .kind-liveness-failed { color: #fca5a5; }
	.feed .kind-run-merged, .feed .kind-deploy-observed { color: #86efac; }
	.prov { display: flex; gap: 8px; flex-wrap: wrap; }
	.prov a { color: #7cc4ff; text-decoration: none; font-size: 11px; font-variant-numeric: tabular-nums; }
	.prov a:hover { text-decoration: underline; }

	.composer {
		position: fixed; width: 22rem; max-width: calc(100vw - 24px); pointer-events: auto;
		display: flex; flex-direction: column; gap: 8px; padding: 11px;
		background: #1f2023; border: 1px solid #3d4045; border-radius: 10px;
		box-shadow: 0 16px 48px rgba(0,0,0,.5);
	}
	.composer[hidden] { display: none !important; }
	.context { font-size: 11px; color: #9aa0a6; word-break: break-word; }
	.composer textarea {
		width: 100%; resize: vertical; min-height: 3.6em; padding: 7px 9px;
		background: #141517; color: #e8eaed; border: 1px solid #3d4045; border-radius: 7px;
		font: inherit; font-size: 12px;
	}
	.composer textarea:focus { outline: 2px solid #3b82f6; outline-offset: -1px; }
	.actions { display: flex; justify-content: flex-end; gap: 7px; }
	.btn {
		appearance: none; font: inherit; font-size: 12px; padding: 6px 13px; border-radius: 7px; cursor: pointer;
		border: 1px solid #3d4045; background: #26282c; color: #d6d9dd;
	}
	.btn:hover { background: #303236; }
	.btn.primary { background: #3b82f6; border-color: #3b82f6; color: #fff; }
	.btn.primary:hover { background: #2f6fd8; }
	.btn:disabled { opacity: .55; cursor: default; }
	.msg { font-size: 11px; color: #fca5a5; margin: 0; min-height: 1em; }
	.msg.ok { color: #86efac; }

	.hint {
		position: fixed; left: 50%; transform: translateX(-50%); top: 14px;
		background: #1f2023; border: 1px solid #3d4045; border-radius: 999px;
		padding: 6px 14px; font-size: 12px; color: #d6d9dd; pointer-events: none;
		box-shadow: 0 6px 24px rgba(0,0,0,.38);
	}
	.hint[hidden] { display: none !important; }
</style>
<div class="layer">
	<svg class="draw" id="draw" aria-hidden="true"></svg>
	<div class="hint" id="hint" hidden></div>
	<div class="dock">
		<div class="panel" id="panel" hidden role="dialog" aria-label="App Harness build activity">
			<div class="panel-head">
				<div>
					<div class="panel-title">Build activity</div>
					<div class="panel-sub" id="panel-sub">Connecting…</div>
				</div>
				<button class="close" id="panel-close" type="button" aria-label="Close">×</button>
			</div>
			<div class="panel-body">
				<div class="section-label">Queue</div>
				<div class="queue" id="queue"></div>
				<div class="queue-empty" id="queue-empty">Nothing building right now.</div>
				<div class="section-label">Activity</div>
				<ol class="feed" id="feed"></ol>
				<div class="feed-empty" id="feed-empty">No activity yet.</div>
			</div>
		</div>
		<div class="pill">
			<button class="tool" id="t-target" type="button" aria-pressed="false" title="Point at an element and request a change">Target</button>
			<button class="tool" id="t-comment" type="button" aria-pressed="false" title="Comment on an element">Comment</button>
			<button class="tool" id="t-draw" type="button" aria-pressed="false" title="Draw on the page">Draw</button>
			<button class="status" id="status-toggle" type="button" aria-expanded="false" title="Show build queue and activity">
				<span class="dot" id="dot"></span><span id="status-text">0 active</span>
			</button>
		</div>
	</div>
	<form class="composer" id="composer" hidden>
		<span class="context" id="context"></span>
		<textarea id="input" rows="2" aria-label="Describe the change"></textarea>
		<div class="actions">
			<button type="button" class="btn" id="cancel">Cancel</button>
			<button type="submit" class="btn primary" id="submit" title="Submit (Cmd/Ctrl + Enter)">Submit</button>
		</div>
		<p class="msg" id="msg"></p>
	</form>
</div>`;

	const $ = (id) => root.getElementById(id);
	const drawLayer = $("draw"), hint = $("hint");
	const panel = $("panel"), panelSub = $("panel-sub"), queueEl = $("queue"), queueEmpty = $("queue-empty");
	const feedEl = $("feed"), feedEmpty = $("feed-empty");
	const statusToggle = $("status-toggle"), statusText = $("status-text"), dot = $("dot");
	const composer = $("composer"), context = $("context"), input = $("input"), msg = $("msg");
	const submit = $("submit"), cancel = $("cancel");
	const tools = { target: $("t-target"), comment: $("t-comment"), draw: $("t-draw") };

	function mount() {
		(document.body || document.documentElement).append(host);
	}
	if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount, { once: true });

	// ---- State ---------------------------------------------------------------

	let socket = null, reconnectTimer = null, connected = false;
	let mode = null, selected = null, selectedEnvelope = null, pendingDraw = null;
	let drawing = false, draftPoints = [], draftPath = null;
	let queueCount = 0, optimistic = 0;
	const pending = new Map();
	const renderedFeed = new Set();
	// The overlay marks the app's DOM with ONE attribute while targeting, and
	// removes it on clear. It is the only write the overlay ever performs, it
	// is visual-only, and it never persists past a selection.
	const HILITE = "data-app-harness-hilite";

	function setHint(text) {
		hint.textContent = text || "";
		hint.hidden = !text;
	}

	function updateStatus() {
		const count = queueCount + pending.size + optimistic;
		statusText.textContent = `${count} active`;
		dot.className = `dot${count > 0 ? " busy" : connected ? " live" : ""}`;
		panelSub.textContent = connected ? (count > 0 ? `${count} in flight` : "Idle · connected") : "Reconnecting…";
	}

	function renderQueue(chips) {
		queueEl.replaceChildren();
		const list = chips || [];
		for (const chip of list) {
			const row = document.createElement("div");
			row.className = "queue-item";
			const d = document.createElement("span");
			d.className = "dot busy";
			const label = document.createElement("span");
			label.textContent = chip.label;
			row.append(d, label);
			queueEl.append(row);
		}
		queueEmpty.hidden = list.length > 0;
		queueCount = list.length;
		updateStatus();
	}

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
			// Newest first.
			const before = [...feedEl.children].find((child) => Number(child.dataset.seq) < Number(item.seq));
			feedEl.insertBefore(li, before ?? null);
		}
		feedEmpty.hidden = feedEl.children.length > 0;
	}

	// ---- Targeting -----------------------------------------------------------

	/** True when the node belongs to the overlay rather than the app. */
	const isOverlay = (node) => node === host || (node instanceof Node && host.contains(node));

	function clearSelection() {
		if (selected) selected.removeAttribute(HILITE);
		selected = null; selectedEnvelope = null; pendingDraw = null;
	}

	function setMode(next) {
		mode = mode === next ? null : next;
		for (const [name, button] of Object.entries(tools)) button.setAttribute("aria-pressed", String(mode === name));
		drawLayer.classList.toggle("active", mode === "draw");
		setHint(mode === "target" ? "Click any element to request a change · Esc to cancel"
			: mode === "comment" ? "Click any element to comment · Esc to cancel"
			: mode === "draw" ? "Drag to draw · Esc to cancel" : "");
		if (mode === null) clearSelection(); else closeComposer(false);
	}
	const clearMode = () => { mode = null; for (const b of Object.values(tools)) b.setAttribute("aria-pressed", "false"); drawLayer.classList.remove("active"); setHint(""); };

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
		input.value = "";
		input.placeholder = kind === "comment" ? "Leave feedback…" : "Request a change…";
		msg.textContent = ""; msg.classList.remove("ok");
		submit.disabled = false; composer.hidden = false;
		positionComposer(anchor); input.focus();
	}

	function closeComposer(clear = true) {
		composer.hidden = true;
		if (clear) clearSelection();
	}

	// Capture-phase, so the app never sees the click that selects an element.
	document.addEventListener("click", (event) => {
		if (mode !== "target" && mode !== "comment") return;
		if (isOverlay(event.target)) return;
		const element = event.target;
		if (!(element instanceof Element)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		clearSelection();
		selected = element;
		element.setAttribute(HILITE, "");
		selectedEnvelope = captureEnvelope(element);
		const kind = mode;
		clearMode();
		openComposer(kind, `${kind === "comment" ? "Comment on" : "Target"}: ${selectedEnvelope.label}`, { x: event.clientX, y: event.clientY });
	}, true);

	const pathFor = (points) => points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");

	drawLayer.addEventListener("pointerdown", (event) => {
		if (mode !== "draw") return;
		event.preventDefault();
		drawing = true;
		draftPoints = [{ x: Math.round(event.clientX), y: Math.round(event.clientY) }];
		draftPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
		drawLayer.append(draftPath);
		drawLayer.setPointerCapture(event.pointerId);
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
		// Hit-test the app UNDER the overlay: the host is pointer-transparent at
		// this moment, so elementFromPoint returns the app's element.
		drawLayer.classList.remove("active");
		const under = document.elementFromPoint(draftPoints[0].x, draftPoints[0].y);
		const target = under && !isOverlay(under) ? under : document.body;
		pendingDraw = { points: draftPoints.slice(0, 600), envelope: captureEnvelope(target), path: draftPath };
		draftPath = null;
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
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		if (!composer.hidden) { pendingDraw?.path?.remove(); closeComposer(); }
		clearMode();
	});
	for (const [name, button] of Object.entries(tools)) button.addEventListener("click", () => setMode(name));

	statusToggle.addEventListener("click", () => {
		panel.hidden = !panel.hidden;
		statusToggle.setAttribute("aria-expanded", String(!panel.hidden));
	});
	$("panel-close").addEventListener("click", () => {
		panel.hidden = true;
		statusToggle.setAttribute("aria-expanded", "false");
	});

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
	start();
	updateStatus();
})();
