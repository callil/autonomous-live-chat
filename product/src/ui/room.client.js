/* The room client (product surface — agent-editable). */
(() => {
	"use strict";
	const $ = (selector) => document.querySelector(selector);
	const messages = $("#messages"), dot = $("#dot"), connection = $("#connection"), concurrentUsers = $("#concurrent-users");
	const composer = $("#composer"), chatInput = $("#chat-input"), imageUpload = $("#image-upload"), sendButton = $("#send");
	const roomIntro = $("#room-intro"), roomIntroDismiss = $("#room-intro-dismiss");
	const join = $("#join"), joinForm = $("#join-form"), joinName = $("#join-name"), joinError = $("#join-error");
	const accountButton = $("#account-button"), accountCancel = $("#account-cancel"), joinTitle = $("#join-title"), accountSave = $("#account-save");

	// Each topic is its own durable conversation and request stream. The main
	// space is deliberately broad, while topical prompts carry narrower context.
	const rooms = {
		main: { label: "All rooms", title: "self driving chat", prompt: "Ask for a change or ask Arbitrator about the app", intro: "Prompts here can shape the whole platform. You can also ask Arbitrator how a feature works or how a build is progressing." },
		design: { label: "Design", title: "design room", prompt: "Prompt a design change", intro: "Prompts here focus on visual design and experience." },
		features: { label: "Features", title: "feature room", prompt: "Prompt a feature for this room", intro: "Prompts here focus on features that make sense for this room." },
		bugs: { label: "Bugs", title: "bug room", prompt: "Describe a bug to fix", intro: "Prompts here focus on fixes while preserving unrelated behavior." },
	};
	const match = String(location.hash || "").match(/(?:^#|&)room=([a-z-]+)/u);
	const roomId = match && Object.hasOwn(rooms, match[1]) ? match[1] : "main";
	const room = rooms[roomId], roomHeading = $(".room-heading"), roomTitle = $(".room-title");
	const roomSwitcher = document.createElement("select");
	roomSwitcher.id = "room-switcher";
	roomSwitcher.setAttribute("aria-label", "Choose a topic room");
	roomSwitcher.title = "Choose a topic room";
	for (const [id, details] of Object.entries(rooms)) {
		const option = document.createElement("option");
		option.value = id; option.textContent = details.label; option.selected = id === roomId; roomSwitcher.append(option);
	}
	roomHeading.append(roomSwitcher);
	roomTitle.textContent = room.title;
	chatInput.placeholder = room.prompt;
	const introCopy = roomIntro.querySelector("p");
	if (introCopy) introCopy.textContent = `${room.intro} Choose All rooms when a change should apply everywhere.`;
	const overlayScript = $("script[data-room]");
	if (overlayScript) overlayScript.setAttribute("data-room", roomId);
	const roomStyles = document.createElement("style");
	roomStyles.textContent = ".room-heading{gap:.55rem;align-items:center}.room-heading select{max-width:8.5rem;padding:.2rem .4rem;border:1px solid var(--line);border-radius:.45rem;background:Canvas;color:inherit;font:inherit;font-size:.8rem}.room-title{white-space:nowrap}@media(max-width:34rem){.room-title{display:none}}";
	document.head.append(roomStyles);
	roomSwitcher.addEventListener("change", () => { location.hash = `room=${roomSwitcher.value}`; location.reload(); });

	const imageLightbox = document.createElement("div"), lightboxClose = document.createElement("button"), lightboxImage = document.createElement("img");
	imageLightbox.className = "image-lightbox"; imageLightbox.hidden = true; imageLightbox.setAttribute("role", "dialog"); imageLightbox.setAttribute("aria-modal", "true"); imageLightbox.setAttribute("aria-label", "Image preview");
	lightboxClose.className = "image-lightbox-close"; lightboxClose.type = "button"; lightboxClose.setAttribute("aria-label", "Close image preview"); lightboxClose.textContent = "×";
	lightboxImage.alt = "Uploaded image preview"; imageLightbox.append(lightboxClose, lightboxImage); document.body.append(imageLightbox);
	function closeImageLightbox() { imageLightbox.hidden = true; lightboxImage.src = ""; }
	function openImageLightbox(source) { lightboxImage.src = source; imageLightbox.hidden = false; }
	lightboxClose.addEventListener("click", closeImageLightbox);
	imageLightbox.addEventListener("click", (event) => { if (event.target === imageLightbox) closeImageLightbox(); });
	document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !imageLightbox.hidden) closeImageLightbox(); });

	let socket = null, reconnectTimer = null, identity = null, everConnected = false;
	const renderedChat = new Set(), cachedChat = [], chatCacheKey = `ahp:room:${roomId}:chat`, people = new Map(), pageLoadedAt = Date.now();
	const arbitratorFacts = [];
	function rememberPerson(person) {
		const name = typeof person === "string" ? person : person?.name ?? person?.displayName ?? person?.author;
		if (typeof name === "string" && name.trim()) people.set(name.trim().toLocaleLowerCase(), name.trim());
	}
	function updateConcurrent(event) {
		const present = event.people || event.members || event.users, count = Array.isArray(present) ? present.length : event.concurrent;
		if (Number.isInteger(count) && count >= 0) concurrentUsers.textContent = `${count} ${count === 1 ? "user" : "users"}`;
	}
	function setConnection(text, live) { connection.textContent = text; dot.classList.toggle("live", live); }
	function avatarColor(name) {
		let hash = 2166136261;
		for (const character of name.trim().normalize("NFKC").toLocaleLowerCase()) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619); }
		return `hsl(${(hash >>> 0) % 360} 70% 40%)`;
	}
	function initials(value) { return value.trim().split(/\s+/u).slice(0, 2).map((part) => part[0]).join("").slice(0, 2) || "G"; }
	function chatKey(message) { return message.seq ?? `${message.author}:${message.at}:${message.text}`; }
	function cacheChat(message) {
		cachedChat.push({ seq: message.seq, author: message.author, at: message.at, text: message.text });
		try { localStorage.setItem(chatCacheKey, JSON.stringify(cachedChat)); } catch { /* Server history remains authoritative. */ }
	}
	function addChat(message, cache = true) {
		const key = chatKey(message); if (renderedChat.has(key)) return; renderedChat.add(key); if (cache) cacheChat(message); rememberPerson(message.author);
		const row = document.createElement("article"), avatar = document.createElement("div"), body = document.createElement("div"), meta = document.createElement("div"), author = document.createElement("span"), time = document.createElement("time"), text = document.createElement("span");
		const color = avatarColor(message.author ?? "");
		row.className = "message"; avatar.className = "message-avatar"; avatar.textContent = initials(message.author ?? ""); avatar.style.color = color; avatar.setAttribute("aria-hidden", "true");
		body.className = "message-body"; meta.className = "message-meta"; author.className = "author"; author.textContent = message.author; author.style.color = color;
		if (message.at) { time.dateTime = new Date(message.at).toISOString(); time.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(message.at); }
		meta.append(author, time); text.className = "message-text";
		if (/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/iu.test(message.text || "")) {
			const preview = document.createElement("button"), image = document.createElement("img"); preview.className = "image-preview-button"; preview.type = "button"; preview.setAttribute("aria-label", "View uploaded image"); image.className = "message-image"; image.src = message.text; image.alt = "Uploaded image"; preview.append(image); preview.addEventListener("click", () => openImageLightbox(image.src)); text.append(preview);
		} else text.textContent = message.text;
		body.append(meta, text); row.append(avatar, body); messages.append(row); row.scrollIntoView({ block: "end", behavior: renderedChat.size > 1 ? "smooth" : "auto" });
	}
	function rememberFacts(event) {
		for (const item of event.items || event.feed?.items || []) {
			if (item && typeof item === "object") arbitratorFacts.push(item);
		}
		if (arbitratorFacts.length > 100) arbitratorFacts.splice(0, arbitratorFacts.length - 100);
	}
	function progressAnswer() {
		const latest = arbitratorFacts.at(-1);
		if (!latest) return "I don't have a build update in the room feed yet. When a change is requested, I delegate it to a builder, wait for CI, and report when the deployed revision is live.";
		const kind = String(latest.kind || "");
		const states = {
			"run-queued": "The change is queued for a builder.",
			"run-started": "A builder is working on the change now.",
			"run-heartbeat": `The builder is working now${latest.refs?.step ? `: ${latest.refs.step}` : "."}`,
			"run-verifying": "The builder returned the change and CI is verifying it.",
			"deploy-observed": "The latest change passed verification and is live.",
			"run-failed": "The latest build needs attention after the builder reported a failure.",
			"intent-parked": "The latest change is parked rather than being deployed.",
		};
		return states[kind] || `The latest progress update is “${latest.title || latest.label || kind.replaceAll("-", " ") || "recorded in the activity feed"}.”`;
	}
	function arbitratorAnswer(value) {
		if (roomId !== "main" || typeof value !== "string") return null;
		const text = value.trim().toLocaleLowerCase();
		const asks = text.includes("?") || /^(how|what|where|when|is|are|can|does|do)\b/u.test(text);
		if (!asks) return null;
		if (/reaction|emoji|like|love|laugh/u.test(text)) return "To react, double-click a message (or right-click it) to open the reaction picker, then choose 👍, ❤️, or 😂. Choose the selected reaction again to remove it.";
		if (/upload|image|photo|picture/u.test(text)) return "Use the ＋ button beside the message box to upload an image. Select the image in chat to open its full preview.";
		if (/room|topic|design|feature|bug/u.test(text) && /where|switch|choose|find|use/u.test(text)) return "Use the room menu in the header to switch between All rooms, Design, Features, and Bugs. Use All rooms for changes that should apply everywhere.";
		if (/progress|status|building|builder|build|delegat|ci|deploy|live|working/u.test(text)) return progressAnswer();
		if (/how.*(app|work)|feature|use|where/u.test(text)) return "Ask me about a feature by name and I'll explain where it is and how to invoke it. I can also summarize the latest builder, CI, and deployment progress from the room feed.";
		return null;
	}
	function receiveChat(message, cache = true) {
		addChat(message, cache);
		const answer = message.author === "Arbitrator" ? null : arbitratorAnswer(message.text);
		if (answer) addChat({ seq: `arbitrator:${chatKey(message)}`, author: "Arbitrator", at: Number(message.at) + 1 || Date.now(), text: answer }, false);
	}
	try {
		const saved = JSON.parse(localStorage.getItem(chatCacheKey) || "[]");
		if (Array.isArray(saved)) saved.forEach((message) => { cachedChat.push(message); receiveChat(message, false); });
	} catch { /* Ignore unavailable or damaged local storage. */ }

	function send(payload) { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); }
	function setIdentity(value) { identity = value; rememberPerson(value); accountButton.hidden = false; }
	function showAccount() { joinTitle.textContent = "Update your account"; accountSave.textContent = "Save"; accountCancel.hidden = false; joinName.value = identity?.name ?? identity?.displayName ?? ""; joinError.textContent = ""; join.hidden = false; joinName.focus(); }
	function connect() {
		clearTimeout(reconnectTimer);
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		socket = new WebSocket(`${proto}//${location.host}/api/rooms/${roomId}`);
		socket.addEventListener("open", () => { setConnection("Live", true); if (everConnected) document.dispatchEvent(new CustomEvent("ahp:version-recheck")); everConnected = true; });
		socket.addEventListener("close", () => {
			setConnection("Reconnecting", false);
			fetch("/api/session", { cache: "no-store" }).then((response) => { if (response.ok) reconnectTimer = setTimeout(connect, 1500); else { setConnection("Signed out", false); join.hidden = false; } }).catch(() => { reconnectTimer = setTimeout(connect, 1500); });
		});
		socket.addEventListener("error", () => socket.close());
		socket.addEventListener("message", ({ data }) => {
			let event; try { event = JSON.parse(data); } catch { return; }
			rememberFacts(event);
			if (event.type === "room:snapshot") { (event.chat || []).forEach(receiveChat); (event.people || event.members || event.users || []).forEach(rememberPerson); updateConcurrent(event); if (event.you) setIdentity(event.you); }
			for (const item of event.items || event.feed?.items || []) if (item?.kind === "deploy-observed" && typeof item.refs?.sha === "string" && item.at >= pageLoadedAt) document.dispatchEvent(new CustomEvent("ahp:deploy-observed", { detail: { sha: item.refs.sha } }));
			if (event.type === "chat:message") receiveChat(event);
			if (event.type === "room:presence" || event.type === "presence:update") { (event.people || event.members || event.users || []).forEach(rememberPerson); updateConcurrent(event); }
		});
	}

	composer.addEventListener("submit", (event) => { event.preventDefault(); const text = chatInput.value.trim(); if (!text) return; send({ type: "chat:send", text }); chatInput.value = ""; });
	imageUpload.addEventListener("change", () => {
		const file = imageUpload.files?.[0]; if (!file || !file.type.startsWith("image/")) return; const reader = new FileReader();
		reader.addEventListener("load", () => { if (typeof reader.result === "string") send({ type: "chat:send", text: reader.result }); imageUpload.value = ""; }); reader.readAsDataURL(file);
	});
	chatInput.addEventListener("keydown", (event) => {
		if (event.key === "Tab") {
			const before = chatInput.value.slice(0, chatInput.selectionStart), found = before.match(/(^|\s)@([^\s@]*)$/u);
			if (found) { const choices = [...people.values()].filter((name) => name.toLocaleLowerCase().startsWith(found[2].toLocaleLowerCase())); if (choices.length) { event.preventDefault(); const start = chatInput.selectionStart - found[2].length; chatInput.setRangeText(`${choices[0]} `, start, chatInput.selectionStart, "end"); } } return;
		}
		if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); }
	});
	sendButton.disabled = false; roomIntroDismiss.addEventListener("click", () => { roomIntro.hidden = true; }); accountButton.addEventListener("click", showAccount); accountCancel.addEventListener("click", () => { join.hidden = true; });
	joinForm.addEventListener("submit", async (event) => {
		event.preventDefault(); const name = joinName.value.trim(), joinButton = joinForm.querySelector("button[type=submit]"); joinButton.disabled = true; joinError.textContent = identity ? "Saving…" : "Joining…";
		try { const response = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); if (!response.ok) { joinError.textContent = (await response.text()) || `Save failed (${response.status}).`; return; } setIdentity(await response.json()); joinError.textContent = ""; join.hidden = true; if (!socket) connect(); }
		catch { joinError.textContent = "Could not reach the room. Try again."; } finally { joinButton.disabled = false; }
	});
	fetch("/api/session").then(async (response) => { if (response.ok) { setIdentity(await response.json()); connect(); } else join.hidden = false; }).catch(() => { join.hidden = false; });
	window.__ahpBooted = true;
})();
