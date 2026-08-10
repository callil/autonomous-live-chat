import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSandbox, runScript } from "../../platform/test/support/dom.mjs";

/**
 * ROOM BOOT — behaviour, not content.
 *
 * This file tests THE APP an agent is allowed to rewrite. So it asserts only
 * what must be true of any version of a chat room: it boots without throwing,
 * it can send a message, a message from the server appears, the send control is
 * reachable by a pointer, and the page announces itself booted so the error
 * boundary stands down.
 *
 * It deliberately does NOT assert on copy, colours, spacing, class names,
 * element counts, or DOM shape beyond the landmarks the app needs to function.
 * An agent asked to reword the heading, restyle the messages, or rebuild the
 * layout must be able to do it and stay green — a test that blocks a legitimate
 * change is not a safety net, it is a rejected user request.
 */

const html = await readFile(new URL("../src/ui/room.html", import.meta.url), "utf8");
const client = await readFile(new URL("../src/ui/room.client.js", import.meta.url), "utf8");

/** Boot the real room page + client the way a browser does. */
function bootRoom() {
	const harness = createSandbox({ html });
	runScript(client, harness.sandbox);
	return harness;
}

/** Resolve the initial session probe so the client reaches its connected state. */
async function bootJoined() {
	const harness = bootRoom();
	const probe = harness.fetches.at(-1);
	probe.respond({ ok: true, json: async () => ({ id: "s1", name: "Ada" }) });
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	return harness;
}

test("the room client boots without throwing and reports itself booted", () => {
	// __ahpBooted is what stands the error boundary down. If the client throws
	// on load, the page silently redirects every visitor to the fallback UI —
	// which is an outage that looks like a working deploy.
	let harness;
	assert.doesNotThrow(() => {
		harness = bootRoom();
	}, "the room client must not throw while loading");
	assert.equal(harness.sandbox.window.__ahpBooted, true, "the client must mark itself booted or the error boundary bails to /fallback");
	assert.deepEqual(harness.consoleErrors, [], "booting must not log errors");
});

test("the app's functional landmarks exist, whatever the app looks like", () => {
	// These are the hooks the app's own behaviour depends on — not styling, not
	// copy. An agent may restyle or reword everything around them.
	const { document } = bootRoom();
	for (const id of ["messages", "composer", "chat-input", "send", "join", "join-form"]) {
		assert.ok(document.getElementById(id), `#${id} is load-bearing for the room to function`);
	}
});

test("the send control is present, enabled, and hittable by a pointer", () => {
	// The overlay floats over this app. When its container swallowed clicks, the
	// Send button became unclickable in production while every test passed.
	// Hit-testing is geometric here, so a control covered or disabled fails.
	const { document } = bootRoom();
	const send = document.getElementById("send");
	send.setRect({ left: 1180, top: 660, width: 80, height: 40 });
	assert.equal(send.disabled, false, "the send control must be usable once the client boots");
	const hit = document.elementFromPoint(1220, 680);
	assert.equal(hit, send, "a click on the send control must reach the send control");
});

test("a typed message round-trips: submitting the composer sends it on the socket", async () => {
	const { document, sockets } = await bootJoined();
	assert.equal(sockets.length, 1, "a joined room opens exactly one socket");
	sockets[0].emit("open", {});

	document.getElementById("chat-input").value = "  hello room  ";
	document.getElementById("composer").dispatchEvent({ type: "submit" });

	assert.equal(sockets[0].sent.length, 1, "submitting the composer must put a message on the wire");
	const payload = JSON.parse(sockets[0].sent[0]);
	assert.equal(payload.type, "chat:send", "the app speaks the room's chat protocol");
	assert.equal(payload.text, "hello room", "the typed words arrive intact and trimmed");
	assert.equal(document.getElementById("chat-input").value, "", "the composer clears after sending");
});

test("an empty message is never sent", async () => {
	const { document, sockets } = await bootJoined();
	sockets[0].emit("open", {});
	document.getElementById("chat-input").value = "   ";
	document.getElementById("composer").dispatchEvent({ type: "submit" });
	assert.equal(sockets[0].sent.length, 0, "whitespace is not a message");
});

test("a message from the server is rendered into the room", async () => {
	const { document, sockets } = await bootJoined();
	sockets[0].emit("open", {});
	const messages = document.getElementById("messages");
	const before = messages.children.length;

	sockets[0].deliver({ type: "chat:message", seq: 1, author: "Ada", text: "first", at: 1_700_000_000_000 });

	assert.equal(messages.children.length, before + 1, "an incoming message must appear in the room");
	// The text must be present SOMEWHERE in the rendered row. How it is laid out,
	// styled, or decorated is the app's business and an agent's to change.
	const rendered = messages.children.at(-1).descendants().map((element) => element.textContent).join(" ");
	assert.match(rendered, /first/u, "the message body is rendered");
	assert.match(rendered, /Ada/u, "the speaker is attributed");
});

test("the same message delivered twice renders once", async () => {
	// Reconnects replay history; a room that double-renders on every reconnect
	// is broken in a way no snapshot of the markup would reveal.
	const { document, sockets } = await bootJoined();
	sockets[0].emit("open", {});
	const messages = document.getElementById("messages");
	const message = { type: "chat:message", seq: 7, author: "Ada", text: "once", at: 1_700_000_000_000 };
	sockets[0].deliver(message);
	const after = messages.children.length;
	sockets[0].deliver(message);
	assert.equal(messages.children.length, after, "a replayed message must not duplicate");
});

test("the app ignores the overlay's harness traffic instead of choking on it", async () => {
	// The app and the overlay share one socket. Build facts belong to the
	// overlay; the app must skip them silently rather than crash or render them.
	const { document, sockets, consoleErrors } = await bootJoined();
	sockets[0].emit("open", {});
	const messages = document.getElementById("messages");
	const before = messages.children.length;
	for (const frame of [{ type: "feed:update", queue: [], items: [] }, { type: "request:ack", intentId: "i1" }, { type: "room:notice", text: "parked" }]) {
		assert.doesNotThrow(() => sockets[0].deliver(frame));
	}
	assert.doesNotThrow(() => sockets[0].emit("message", { data: "{{ not json" }));
	assert.equal(messages.children.length, before, "harness frames are not conversation");
	assert.deepEqual(consoleErrors, []);
});

test("a visitor with no session is shown the join flow, and joining connects the room", async () => {
	const harness = bootRoom();
	harness.fetches.at(-1).respond({ ok: false, status: 401, text: async () => "" });
	await Promise.resolve();
	await Promise.resolve();
	const { document, sockets, fetches } = harness;
	assert.equal(document.getElementById("join").hidden, false, "an anonymous visitor must be able to join");
	assert.equal(sockets.length, 0, "no socket before there is a session");

	document.getElementById("join-name").value = "Ada";
	document.getElementById("join-form").dispatchEvent({ type: "submit" });
	await Promise.resolve();
	const join = fetches.at(-1);
	assert.match(join.url, /\/api\/session/u);
	assert.equal(join.init.method, "POST", "joining creates a session");
	join.respond({ ok: true, json: async () => ({ id: "s1", name: "Ada" }) });
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(sockets.length, 1, "a successful join connects the room");
});

test("a failed join surfaces the reason and leaves the visitor able to retry", async () => {
	// Silent failure here means a user who cannot get in and is told nothing.
	const harness = bootRoom();
	harness.fetches.at(-1).respond({ ok: false, status: 401, text: async () => "" });
	await Promise.resolve();
	await Promise.resolve();
	const { document, fetches } = harness;
	document.getElementById("join-name").value = "Ada";
	const submitButton = document.getElementById("join-form").querySelector("button[type=submit]");
	document.getElementById("join-form").dispatchEvent({ type: "submit" });
	await Promise.resolve();
	fetches.at(-1).respond({ ok: false, status: 429, text: async () => "Too many people" });
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();

	assert.match(document.getElementById("join-error").textContent, /\S/u, "a failed join must say something");
	assert.equal(submitButton.disabled, false, "the visitor can try again");
});

test("the app connects same-origin over a secure socket, never to a hardcoded host", async () => {
	// The product is binding-isolated: it must reach the platform through its
	// own origin, so a moved platform never strands the app.
	const { sockets } = await bootJoined();
	const url = new URL(sockets[0].url);
	assert.equal(url.protocol, "wss:", "an https page must use a secure socket");
	assert.equal(url.host, "app.test", "the room socket is same-origin");
});

test("losing the connection schedules a reconnect rather than going quiet", async () => {
	const { sockets, timers, fetches } = await bootJoined();
	sockets[0].emit("open", {});
	sockets[0].emit("close", {});
	// The client re-checks the session before retrying, so a still-valid
	// session reconnects and an expired one re-shows the join scrim instead
	// of looping a doomed reconnect forever.
	await Promise.resolve();
	fetches.at(-1).respond({ ok: true, json: async () => ({ id: "s1", name: "Ada" }) });
	await Promise.resolve();
	await Promise.resolve();
	assert.ok(timers.some((timer) => !timer.repeating && timer.ms > 0), "a dropped socket must schedule a retry");
});

test("an expired session on reconnect re-shows the join scrim instead of looping", async () => {
	const { document, sockets, timers, fetches } = await bootJoined();
	sockets[0].emit("open", {});
	const timersBefore = timers.length;
	sockets[0].emit("close", {});
	await Promise.resolve();
	fetches.at(-1).respond({ ok: false, status: 401, text: async () => "A signed session is required." });
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(document.getElementById("join").hidden, false, "an expired session must surface the join scrim");
	assert.equal(timers.length, timersBefore, "no reconnect is scheduled for a session that cannot succeed");
});

test("the page carries the boot contract the platform's fallback and version checks rely on", () => {
	// These are integration points with the frozen platform, not app content:
	// the fallback target, the version stamp the reconciler observes, and the
	// overlay tag. The app may change everything else on the page.
	const { document } = bootRoom();
	assert.ok(document.querySelector('meta[name=ahp-fallback]'), "the error boundary needs its fallback target");
	assert.ok(document.querySelector('meta[name=ahp-version]'), "the deploy observer reads the version stamp");
	const overlayTag = html.includes('src="/overlay.js"');
	assert.ok(overlayTag, "the app embeds the platform overlay: one tag is the whole integration");
});
