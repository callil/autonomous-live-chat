/* The room client (product surface — agent-editable).
 *
 * Speaks ONLY to the platform's room WebSocket and narrow HTTP API, proxied
 * same-origin by the product worker. Identity is the platform's signed
 * session cookie; the sole request trigger is an explicit Target / Comment /
 * Draw envelope carrying the build-stamped data-loc ref plus the captured DOM
 * verbatim. Plain chat is chat.
 */
(() => {
	"use strict";

	const SOURCE = "product/src/ui/room.client.js";
	const REPO_URL = "https://github.com/callil/autonomous-live-chat";
	const MAX_SNAPSHOT_CHARS = 4000;
	const STYLE_KEYS = ["color", "background-color", "font-size", "font-weight", "padding", "margin", "border", "border-radius", "display"];
	const MIN_DRAW_DISTANCE = 3;
	const COMPOSER_GUTTER = 12;

	const $ = (selector) => document.querySelector(selector);
	const messages = $("#messages"), feedItems = $("#feed-items"), queueChips = $("#queue-chips"), pendingAcks = $("#pending-acks");
	const dot = $("#dot"), connection = $("#connection");
	const composer = $("#composer"), chatInput = $("#chat-input"), sendButton = $("#send");
	const join = $("#join"), joinForm = $("#join-form"), joinName = $("#join-name"), joinError = $("#join-error");
	const toolTarget = $("#tool-target"), toolComment = $("#tool-comment"), toolDraw = $("#tool-draw");
	const requestComposer = $("#request-composer"), requestContext = $("#request-context"), requestInput = $("#request-input");
	const requestError = $("#request-error"), requestSubmit = $("#request-submit"), requestCancel = $("#request-cancel");
	const drawLayer = $("#draw-layer");

	let socket = null, reconnectTimer = null, identity = null;
	let mode = null; // null | "target" | "comment" | "draw"
	let hovered = null, selected = null, selectedEnvelope = null, pendingDraw = null;
	let drawing = false, draftPoints = [], draftPath = null;
	const renderedChat = new Set(), renderedFeed = new Set(), pending = new Map();

	function setConnection(text, live) { connection.textContent = text; dot.classList.toggle("live", live); }
	function stampDynamic(node, label) { node.dataset.loc = `${SOURCE}:${label}`; return node; }

	// --- chat ---------------------------------------------------------------
	function addChat(message) {
		const key = message.seq ?? `${message.author}:${message.at}:${message.text}`;
		if (renderedChat.has(key)) return;
		renderedChat.add(key);
		const row = stampDynamic(document.createElement("article"), "message");
		row.className = "message";
		const author = document.createElement("span");
		author.className = "author";
		author.textContent = message.author;
		const text = document.createElement("span");
		text.className = "message-text";
		text.textContent = message.text;
		const time = document.createElement("time");
		if (message.at) { time.dateTime = new Date(message.at).toISOString(); time.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(message.at); }
		row.append(author, text, time);
		messages.append(row);
		row.scrollIntoView({ block: "end", behavior: renderedChat.size > 1 ? "smooth" : "auto" });
	}

	// --- feed rail ----------------------------------------------------------
	function provenanceLinks(refs) {
		const wrap = document.createElement("span");
		wrap.className = "provenance";
		if (Number.isInteger(refs.prNumber)) {
			const pr = document.createElement("a");
			pr.href = `${REPO_URL}/pull/${refs.prNumber}`;
			pr.target = "_blank"; pr.rel = "noreferrer";
			pr.textContent = `PR #${refs.prNumber}`;
			wrap.append(pr);
		}
		if (typeof refs.sha === "string" && refs.sha.length >= 7) {
			const commit = document.createElement("a");
			commit.href = `${REPO_URL}/commit/${refs.sha}`;
			commit.target = "_blank"; commit.rel = "noreferrer";
			commit.textContent = refs.sha.slice(0, 7);
			wrap.append(commit);
		}
		return wrap.childNodes.length ? wrap : null;
	}

	function addFeedItems(items) {
		for (const item of items || []) {
			if (renderedFeed.has(item.seq)) continue;
			renderedFeed.add(item.seq);
			const row = stampDynamic(document.createElement("li"), "feed-item");
			row.className = `kind-${item.kind}`;
			row.dataset.seq = String(item.seq);
			const text = document.createElement("span");
			text.textContent = item.text;
			row.append(text);
			const links = item.refs ? provenanceLinks(item.refs) : null;
			if (links) row.append(links);
			const before = [...feedItems.children].find((child) => Number(child.dataset.seq) < item.seq);
			feedItems.insertBefore(row, before ?? null);
		}
	}

	function renderQueue(chips) {
		queueChips.replaceChildren();
		for (const chip of chips || []) {
			const el = stampDynamic(document.createElement("span"), "queue-chip");
			el.className = "queue-chip";
			el.textContent = chip.label;
			queueChips.append(el);
		}
	}

	// --- pending acks with honest cancel windows ----------------------------
	function renderPending() {
		pendingAcks.replaceChildren();
		const now = Date.now();
		for (const [intentId, ack] of pending) {
			if (ack.cancelDeadline <= now) { pending.delete(intentId); continue; }
			const row = stampDynamic(document.createElement("div"), "pending-ack");
			row.className = "pending-ack";
			const seconds = Math.max(0, Math.ceil((ack.cancelDeadline - now) / 1000));
			const label = document.createElement("span");
			label.textContent = `Request accepted — dispatching in ${seconds}s`;
			const cancel = document.createElement("button");
			cancel.type = "button";
			cancel.textContent = "Cancel";
			cancel.addEventListener("click", () => {
				send({ type: "request:cancel", intentId });
				pending.delete(intentId);
				renderPending();
			});
			row.append(label, cancel);
			pendingAcks.append(row);
		}
		if (pending.size) setTimeout(renderPending, 500);
	}

	// --- annotation capture --------------------------------------------------
	function locFor(node) { return node instanceof Element ? node.closest("[data-loc]") : null; }

	function captureEnvelope(element) {
		const rect = element.getBoundingClientRect();
		const computed = getComputedStyle(element);
		const computedStyles = {};
		for (const key of STYLE_KEYS) computedStyles[key] = computed.getPropertyValue(key);
		return {
			dataLoc: element.dataset.loc,
			domSnapshot: element.outerHTML.slice(0, MAX_SNAPSHOT_CHARS),
			selector: `[data-loc="${element.dataset.loc}"]`,
			tag: element.tagName.toLowerCase(),
			page: location.pathname,
			rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
			computedStyles,
			viewport: { width: innerWidth, height: innerHeight },
		};
	}

	function setMode(next) {
		mode = mode === next ? null : next;
		for (const [button, name] of [[toolTarget, "target"], [toolComment, "comment"], [toolDraw, "draw"]]) button.setAttribute("aria-pressed", String(mode === name));
		document.body.classList.toggle("mode-target", mode === "target");
		document.body.classList.toggle("mode-comment", mode === "comment");
		document.body.classList.toggle("mode-draw", mode === "draw");
		if (mode === null) clearSelection();
		if (mode !== null) closeRequestComposer();
	}

	function clearSelection() {
		hovered?.classList.remove("loc-hover");
		selected?.classList.remove("loc-selected");
		hovered = selected = selectedEnvelope = pendingDraw = null;
	}

	function positionRequestComposer(anchor) {
		requestComposer.style.left = "0px";
		requestComposer.style.top = "0px";
		const rect = requestComposer.getBoundingClientRect();
		let left = anchor.x + COMPOSER_GUTTER;
		let top = anchor.y + COMPOSER_GUTTER;
		if (left + rect.width > innerWidth - COMPOSER_GUTTER) left = anchor.x - rect.width - COMPOSER_GUTTER;
		if (top + rect.height > innerHeight - COMPOSER_GUTTER) top = anchor.y - rect.height - COMPOSER_GUTTER;
		left = Math.max(COMPOSER_GUTTER, Math.min(left, innerWidth - rect.width - COMPOSER_GUTTER));
		top = Math.max(COMPOSER_GUTTER, Math.min(top, innerHeight - rect.height - COMPOSER_GUTTER));
		requestComposer.style.left = `${left}px`;
		requestComposer.style.top = `${top}px`;
	}

	function openRequestComposer(kind, contextLabel, anchor) {
		requestComposer.dataset.kind = kind;
		requestContext.textContent = contextLabel;
		requestInput.value = "";
		requestInput.placeholder = kind === "comment" ? "Leave feedback…" : "Request a change…";
		requestError.textContent = "";
		requestError.classList.remove("ok");
		requestSubmit.disabled = false;
		requestComposer.hidden = false;
		positionRequestComposer(anchor);
		requestInput.focus();
	}

	function closeRequestComposer() {
		requestComposer.hidden = true;
		clearSelection();
	}

	document.addEventListener("pointerover", (event) => {
		if (mode !== "target" && mode !== "comment") return;
		const candidate = locFor(event.target);
		if (candidate === hovered) return;
		hovered?.classList.remove("loc-hover");
		hovered = candidate;
		hovered?.classList.add("loc-hover");
	}, true);

	document.addEventListener("click", (event) => {
		if (mode !== "target" && mode !== "comment") return;
		const candidate = locFor(event.target);
		if (!candidate || candidate.closest(".overlay-frame")) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		selected?.classList.remove("loc-selected");
		selected = candidate;
		selected.classList.add("loc-selected");
		selectedEnvelope = captureEnvelope(candidate);
		const kind = mode === "comment" ? "comment" : "target";
		setModeOff();
		openRequestComposer(kind, `${kind === "comment" ? "Comment on" : "Target"}: ${selectedEnvelope.dataLoc}`, { x: event.clientX, y: event.clientY });
	}, true);

	function setModeOff() {
		mode = null;
		for (const button of [toolTarget, toolComment, toolDraw]) button.setAttribute("aria-pressed", "false");
		document.body.classList.remove("mode-target", "mode-comment", "mode-draw");
	}

	// --- drawing -------------------------------------------------------------
	function pathFor(points) { return points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" "); }

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
		drawLayer.style.pointerEvents = "none";
		const under = locFor(document.elementFromPoint(draftPoints[0].x, draftPoints[0].y)) ?? document.body;
		drawLayer.style.pointerEvents = "";
		pendingDraw = { points: draftPoints.slice(0, 600), envelope: captureEnvelope(under), path: draftPath };
		draftPath = null;
		setModeOff();
		openRequestComposer("draw", `Drawing over: ${pendingDraw.envelope.dataLoc}`, draftPoints[draftPoints.length - 1]);
	}
	drawLayer.addEventListener("pointerup", finishDraw);
	drawLayer.addEventListener("pointercancel", finishDraw);

	// --- request envelope submit --------------------------------------------
	requestComposer.addEventListener("submit", (event) => {
		event.preventDefault();
		const kind = requestComposer.dataset.kind;
		const text = requestInput.value.trim();
		if (kind !== "draw" && !text.length) { requestError.textContent = kind === "comment" ? "Write a brief comment." : "Describe the change you want."; return; }
		if (!socket || socket.readyState !== WebSocket.OPEN) { requestError.textContent = "The room connection is not ready yet."; return; }
		const clientSubmissionId = crypto.randomUUID();
		let annotation;
		if (kind === "draw") {
			if (!pendingDraw) { requestError.textContent = "Draw something first."; return; }
			annotation = { kind: "draw", ...pendingDraw.envelope, drawingPoints: pendingDraw.points };
		} else if (kind === "comment") annotation = { kind: "comment", ...selectedEnvelope, text };
		else annotation = { kind: "target", ...selectedEnvelope };
		send({ type: `request:${kind}`, text, annotation, clientSubmissionId });
		requestSubmit.disabled = true;
		requestError.textContent = "Submitting…";
	});
	requestInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			if (!requestSubmit.disabled) requestComposer.requestSubmit();
		}
	});
	requestCancel.addEventListener("click", () => { pendingDraw?.path?.remove(); closeRequestComposer(); });

	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			if (!requestComposer.hidden) { pendingDraw?.path?.remove(); closeRequestComposer(); }
			setModeOff();
		}
	});

	toolTarget.addEventListener("click", () => setMode("target"));
	toolComment.addEventListener("click", () => setMode("comment"));
	toolDraw.addEventListener("click", () => setMode("draw"));

	// --- transport -----------------------------------------------------------
	function send(payload) { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); }

	function connect() {
		clearTimeout(reconnectTimer);
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		socket = new WebSocket(`${proto}//${location.host}/api/rooms/main`);
		socket.addEventListener("open", () => setConnection("Live", true));
		socket.addEventListener("close", () => { setConnection("Reconnecting", false); reconnectTimer = setTimeout(connect, 1500); });
		socket.addEventListener("error", () => socket.close());
		socket.addEventListener("message", ({ data }) => {
			let event;
			try { event = JSON.parse(data); } catch { return; }
			if (event.type === "room:snapshot") {
				(event.chat || []).forEach(addChat);
				if (event.feed) { addFeedItems(event.feed.items); renderQueue(event.feed.queue); }
				if (event.you) identity = event.you;
			}
			if (event.type === "chat:message") addChat(event);
			if (event.type === "feed:update") { renderQueue(event.queue); addFeedItems(event.items); }
			if (event.type === "feed:history") addFeedItems(event.items);
			if (event.type === "request:ack") {
				pending.set(event.intentId, { cancelDeadline: event.cancelDeadline });
				renderPending();
				pendingDraw?.path?.remove();
				requestError.classList.add("ok");
				requestError.textContent = "Accepted — watch the feed. You can cancel for a few seconds.";
				requestSubmit.disabled = false;
				setTimeout(closeRequestComposer, 1600);
			}
			if (event.type === "room:notice") {
				if (!requestComposer.hidden) { requestError.classList.remove("ok"); requestError.textContent = event.text; requestSubmit.disabled = false; }
				else addFeedItems([{ seq: `notice-${Date.now()}`, kind: "notice", text: event.text }]);
			}
		});
	}

	// --- chat composer -------------------------------------------------------
	composer.addEventListener("submit", (event) => {
		event.preventDefault();
		const text = chatInput.value.trim();
		if (!text) return;
		send({ type: "chat:send", text });
		chatInput.value = "";
	});
	chatInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); }
	});
	sendButton.disabled = false;

	// --- session bootstrap ---------------------------------------------------
	joinForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		const name = joinName.value.trim();
		const joinButton = joinForm.querySelector("button[type=submit]");
		joinButton.disabled = true;
		joinError.textContent = "Joining…";
		try {
			const response = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
			if (!response.ok) { joinError.textContent = (await response.text()) || `Join failed (${response.status}).`; return; }
			identity = await response.json();
			joinError.textContent = "";
			join.hidden = true;
			connect();
		} catch {
			joinError.textContent = "Could not reach the room. Try again.";
		} finally {
			joinButton.disabled = false;
		}
	});

	fetch("/api/session")
		.then(async (response) => {
			if (response.ok) { identity = await response.json(); connect(); }
			else join.hidden = false;
		})
		.catch(() => { join.hidden = false; });

	window.__ahpBooted = true;
})();
