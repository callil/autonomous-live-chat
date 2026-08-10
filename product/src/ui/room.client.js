/* The room client (product surface — agent-editable). */
(() => {
	"use strict";

	const $ = (selector) => document.querySelector(selector);
	const messages = $("#messages");
	const dot = $("#dot"), connection = $("#connection"), concurrentUsers = $("#concurrent-users");
	const composer = $("#composer"), chatInput = $("#chat-input"), imageUpload = $("#image-upload"), sendButton = $("#send");
	const roomIntro = $("#room-intro"), roomIntroDismiss = $("#room-intro-dismiss");
	const join = $("#join"), joinForm = $("#join-form"), joinName = $("#join-name"), joinError = $("#join-error");
	const accountButton = $("#account-button"), accountCancel = $("#account-cancel"), joinTitle = $("#join-title"), accountSave = $("#account-save");

	let socket = null, reconnectTimer = null, identity = null, everConnected = false;
	const renderedChat = new Set();
	const cachedChat = [];
	const chatCacheKey = "ahp:room:main:chat";
	const people = new Map();
	const pageLoadedAt = Date.now();

	function announceDeploys(items) {
		for (const item of items || []) {
			if (item && item.kind === "deploy-observed" && item.refs && typeof item.refs.sha === "string" && item.at >= pageLoadedAt) {
				document.dispatchEvent(new CustomEvent("ahp:deploy-observed", { detail: { sha: item.refs.sha } }));
			}
		}
	}

	function rememberPerson(person) {
		const name = typeof person === "string" ? person : person?.name ?? person?.displayName ?? person?.author;
		if (typeof name === "string" && name.trim()) people.set(name.trim().toLocaleLowerCase(), name.trim());
	}

	function updateConcurrent(event) {
		const present = event.people || event.members || event.users;
		const count = Array.isArray(present) ? present.length : event.concurrent;
		if (Number.isInteger(count) && count >= 0) concurrentUsers.textContent = `${count} ${count === 1 ? "user" : "users"}`;
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
	function chatKey(message) { return message.seq ?? `${message.author}:${message.at}:${message.text}`; }

	function cacheChat(message) {
		cachedChat.push({ seq: message.seq, author: message.author, at: message.at, text: message.text });
		try { localStorage.setItem(chatCacheKey, JSON.stringify(cachedChat)); } catch { /* The live server remains authoritative if storage is unavailable. */ }
	}

	function addChat(message, cache = true) {
		const key = chatKey(message);
		if (renderedChat.has(key)) return;
		renderedChat.add(key);
		if (cache) cacheChat(message);
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
		text.className = "message-text";
		if (/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/iu.test(message.text || "")) {
			const image = document.createElement("img");
			image.src = message.text; image.alt = "Uploaded image"; image.style.maxWidth = "min(100%, 32rem)"; image.style.maxHeight = "24rem";
			text.append(image);
		} else {
			text.textContent = message.text;
		}
		const time = document.createElement("time");
		if (message.at) {
			time.dateTime = new Date(message.at).toISOString();
			time.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(message.at);
		}
		body.append(author, text, time); row.append(avatar, body); messages.append(row);
		row.scrollIntoView({ block: "end", behavior: renderedChat.size > 1 ? "smooth" : "auto" });
	}

	try {
		const saved = JSON.parse(localStorage.getItem(chatCacheKey) || "[]");
		if (Array.isArray(saved)) saved.forEach((message) => { cachedChat.push(message); addChat(message, false); });
	} catch { /* Ignore damaged or unavailable browser storage. */ }

	function send(payload) { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); }
	function showAccount() {
		joinTitle.textContent = "Update your account"; accountSave.textContent = "Save"; accountCancel.hidden = false;
		joinName.value = identity?.name ?? identity?.displayName ?? ""; joinError.textContent = ""; join.hidden = false; joinName.focus();
	}
	function setIdentity(value) { identity = value; rememberPerson(value); accountButton.hidden = false; }

	function connect() {
		clearTimeout(reconnectTimer);
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		socket = new WebSocket(`${proto}//${location.host}/api/rooms/main`);
		socket.addEventListener("open", () => {
			setConnection("Live", true);
			if (everConnected) document.dispatchEvent(new CustomEvent("ahp:version-recheck"));
			everConnected = true;
		});
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
				updateConcurrent(event);
				if (event.you) setIdentity(event.you);
			}
			announceDeploys(event.items || (event.feed && event.feed.items));
			if (event.type === "chat:message") addChat(event);
			if (event.type === "room:presence" || event.type === "presence:update") {
				(event.people || event.members || event.users || []).forEach(rememberPerson);
				updateConcurrent(event);
			}
		});
	}

	composer.addEventListener("submit", (event) => {
		event.preventDefault();
		const text = chatInput.value.trim();
		if (!text) return;
		send({ type: "chat:send", text }); chatInput.value = "";
	});
	imageUpload.addEventListener("change", () => {
		const file = imageUpload.files?.[0];
		if (!file || !file.type.startsWith("image/")) return;
		const reader = new FileReader();
		reader.addEventListener("load", () => {
			if (typeof reader.result === "string") send({ type: "chat:send", text: reader.result });
			imageUpload.value = "";
		});
		reader.readAsDataURL(file);
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
	roomIntroDismiss.addEventListener("click", () => { roomIntro.hidden = true; });
	accountButton.addEventListener("click", showAccount);
	accountCancel.addEventListener("click", () => { join.hidden = true; });

	joinForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		const name = joinName.value.trim();
		const joinButton = joinForm.querySelector("button[type=submit]");
		joinButton.disabled = true; joinError.textContent = identity ? "Saving…" : "Joining…";
		try {
			const response = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
			if (!response.ok) { joinError.textContent = (await response.text()) || `Save failed (${response.status}).`; return; }
			setIdentity(await response.json()); joinError.textContent = ""; join.hidden = true;
			if (!socket) connect();
		} catch { joinError.textContent = "Could not reach the room. Try again."; }
		finally { joinButton.disabled = false; }
	});

	fetch("/api/session").then(async (response) => {
		if (response.ok) { setIdentity(await response.json()); connect(); } else join.hidden = false;
	}).catch(() => { join.hidden = false; });

	window.__ahpBooted = true;
})();
