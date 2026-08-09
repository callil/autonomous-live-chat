/* The room client (product surface — agent-editable).
 *
 * This is THE APP: a chat room, and nothing else. The authoring tools
 * (Target/Comment/Draw), the build queue, the activity feed, and its
 * provenance links are NOT here — they belong to the App Harness overlay,
 * which the platform serves at /overlay.js into a closed shadow root. That
 * separation is the point: an agent editing this file can change the app
 * freely and can never break or falsify the status surface that reports on
 * its own builds.
 *
 * This file therefore speaks only chat: join, send, receive.
 */
(() => {
	"use strict";

	const $ = (selector) => document.querySelector(selector);
	const messages = $("#messages");
	const dot = $("#dot"), connection = $("#connection");
	const composer = $("#composer"), chatInput = $("#chat-input"), sendButton = $("#send");
	const join = $("#join"), joinForm = $("#join-form"), joinName = $("#join-name"), joinError = $("#join-error");

	let socket = null, reconnectTimer = null, identity = null;
	const renderedChat = new Set();

	function setConnection(text, live) {
		connection.textContent = text;
		dot.classList.toggle("live", live);
	}

	/* Every speaker gets a stable colour derived from their name (FNV-1a over the
	   normalised name), shared by their initials placeholder and their author
	   line so the same person reads the same way everywhere. */
	function avatarColor(name) {
		let hash = 2166136261;
		for (const character of name.trim().normalize("NFKC").toLocaleLowerCase()) {
			hash ^= character.codePointAt(0);
			hash = Math.imul(hash, 16777619);
		}
		return `hsl(${(hash >>> 0) % 360} 70% 40%)`;
	}
	function initials(value) { return value.trim().split(/\s+/u).slice(0, 2).map((part) => part[0]).join("").slice(0, 2) || "G"; }

	function addChat(message) {
		const key = message.seq ?? `${message.author}:${message.at}:${message.text}`;
		if (renderedChat.has(key)) return;
		renderedChat.add(key);
		const row = document.createElement("article");
		row.className = "message";
		const color = avatarColor(message.author ?? "");
		const avatar = document.createElement("div");
		avatar.className = "message-avatar"; avatar.textContent = initials(message.author ?? ""); avatar.style.color = color; avatar.setAttribute("aria-hidden", "true");
		const body = document.createElement("div");
		body.className = "message-body";
		const author = document.createElement("span");
		author.className = "author";
		author.textContent = message.author;
		author.style.color = color;
		const text = document.createElement("span");
		text.className = "message-text";
		text.textContent = message.text;
		const time = document.createElement("time");
		if (message.at) {
			time.dateTime = new Date(message.at).toISOString();
			time.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(message.at);
		}
		body.append(author, text, time);
		row.append(avatar, body);
		messages.append(row);
		row.scrollIntoView({ block: "end", behavior: renderedChat.size > 1 ? "smooth" : "auto" });
	}

	function send(payload) {
		if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
	}

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
			// The app renders conversation. Build facts (feed:update, request:ack,
			// room:notice) are the overlay's business and are ignored here.
			if (event.type === "room:snapshot") {
				(event.chat || []).forEach(addChat);
				if (event.you) identity = event.you;
			}
			if (event.type === "chat:message") addChat(event);
		});
	}

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
		} catch { joinError.textContent = "Could not reach the room. Try again."; }
		finally { joinButton.disabled = false; }
	});

	fetch("/api/session")
		.then(async (response) => { if (response.ok) { identity = await response.json(); connect(); } else join.hidden = false; })
		.catch(() => { join.hidden = false; });

	window.__ahpBooted = true;
})();
