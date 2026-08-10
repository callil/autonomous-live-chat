/* The room client (product surface — agent-editable). */
(() => {
	"use strict";

	const $ = (selector) => document.querySelector(selector);
	const messages = $("#messages");
	const dot = $("#dot"), connection = $("#connection");
	const composer = $("#composer"), chatInput = $("#chat-input"), sendButton = $("#send");
	const join = $("#join"), joinForm = $("#join-form"), joinName = $("#join-name"), joinError = $("#join-error");

	let socket = null, reconnectTimer = null, identity = null;
	const renderedChat = new Set();
	const people = new Map();

	function rememberPerson(person) {
		const name = typeof person === "string" ? person : person?.name ?? person?.displayName ?? person?.author;
		if (typeof name === "string" && name.trim()) people.set(name.trim().toLocaleLowerCase(), name.trim());
	}

	function setConnection(text, live) {
		connection.textContent = text;
		dot.classList.toggle("live", live);
	}

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
		rememberPerson(message.author);
		const row = document.createElement("article");
		row.className = "message";
		const color = avatarColor(message.author ?? "");
		const avatar = document.createElement("div");
		avatar.className = "message-avatar"; avatar.textContent = initials(message.author ?? ""); avatar.style.color = color; avatar.setAttribute("aria-hidden", "true");
		const body = document.createElement("div");
		body.className = "message-body";
		const author = document.createElement("span");
		author.className = "author"; author.textContent = message.author; author.style.color = color;
		const text = document.createElement("span");
		text.className = "message-text"; text.textContent = message.text;
		const time = document.createElement("time");
		if (message.at) {
			time.dateTime = new Date(message.at).toISOString();
			time.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(message.at);
		}
		body.append(author, text, time); row.append(avatar, body); messages.append(row);
		row.scrollIntoView({ block: "end", behavior: renderedChat.size > 1 ? "smooth" : "auto" });
	}

	function send(payload) { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); }

	function connect() {
		clearTimeout(reconnectTimer);
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		socket = new WebSocket(`${proto}//${location.host}/api/rooms/main`);
		socket.addEventListener("open", () => setConnection("Live", true));
		socket.addEventListener("close", () => {
			setConnection("Reconnecting", false);
			fetch("/api/session", { cache: "no-store" }).then((response) => {
				if (response.ok) { reconnectTimer = setTimeout(connect, 1500); return; }
				setConnection("Signed out", false); join.hidden = false;
			}).catch(() => { reconnectTimer = setTimeout(connect, 1500); });
		});
		socket.addEventListener("error", () => socket.close());
		socket.addEventListener("message", ({ data }) => {
			let event;
			try { event = JSON.parse(data); } catch { return; }
			if (event.type === "room:snapshot") {
				(event.chat || []).forEach(addChat);
				(event.people || event.members || event.users || []).forEach(rememberPerson);
				if (event.you) { identity = event.you; rememberPerson(event.you); }
			}
			if (event.type === "chat:message") addChat(event);
			if (event.type === "room:presence" || event.type === "presence:update") (event.people || event.members || event.users || []).forEach(rememberPerson);
		});
	}

	composer.addEventListener("submit", (event) => {
		event.preventDefault();
		const text = chatInput.value.trim();
		if (!text) return;
		send({ type: "chat:send", text }); chatInput.value = "";
	});
	chatInput.addEventListener("keydown", (event) => {
		if (event.key === "Tab") {
			const before = chatInput.value.slice(0, chatInput.selectionStart);
			const match = before.match(/(^|\s)@([^\s@]*)$/u);
			if (match) {
				const choices = [...people.values()].filter((name) => name.toLocaleLowerCase().startsWith(match[2].toLocaleLowerCase()));
				if (choices.length) {
					event.preventDefault();
					const start = chatInput.selectionStart - match[2].length;
					chatInput.setRangeText(`${choices[0]} `, start, chatInput.selectionStart, "end");
				}
			}
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); }
	});
	sendButton.disabled = false;

	joinForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		const name = joinName.value.trim();
		const joinButton = joinForm.querySelector("button[type=submit]");
		joinButton.disabled = true; joinError.textContent = "Joining…";
		try {
			const response = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
			if (!response.ok) { joinError.textContent = (await response.text()) || `Join failed (${response.status}).`; return; }
			identity = await response.json(); rememberPerson(identity); joinError.textContent = ""; join.hidden = true; connect();
		} catch { joinError.textContent = "Could not reach the room. Try again."; }
		finally { joinButton.disabled = false; }
	});

	fetch("/api/session").then(async (response) => {
		if (response.ok) { identity = await response.json(); rememberPerson(identity); connect(); } else join.hidden = false;
	}).catch(() => { join.hidden = false; });

	window.__ahpBooted = true;
})();
