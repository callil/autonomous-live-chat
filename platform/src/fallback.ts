/**
 * The platform's minimal fallback UI (task #13): served from FROZEN platform
 * code at GET /fallback, so the room stays reachable and the feed stays
 * readable even when the self-modifiable product bundle is broken. Chat and
 * the truthful feed only — no overlay, no authoring tools. Feed-truth
 * rendering here comes from frozen code by construction.
 */
export const FALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>App Harness — fallback room</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 ui-sans-serif, system-ui, sans-serif; display: grid; grid-template-rows: auto 1fr auto; height: 100dvh; }
  header { padding: .6rem 1rem; border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent); display: flex; gap: .75rem; align-items: baseline; }
  header strong { font-size: 1rem; }
  header .notice { opacity: .7; font-size: .8rem; }
  main { display: grid; grid-template-columns: 1fr minmax(16rem, 24rem); min-height: 0; }
  section { overflow-y: auto; padding: .75rem 1rem; }
  aside { overflow-y: auto; padding: .75rem 1rem; border-left: 1px solid color-mix(in srgb, currentColor 18%, transparent); font-size: .82rem; }
  .msg { margin: .35rem 0; }
  .msg b { margin-right: .4rem; }
  .feed-item { margin: .3rem 0; opacity: .85; }
  .chip { display: inline-block; margin: .15rem .25rem .15rem 0; padding: .1rem .5rem; border: 1px solid currentColor; border-radius: 999px; font-size: .75rem; }
  form { display: flex; gap: .5rem; padding: .6rem 1rem; border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent); }
  input, button { font: inherit; padding: .45rem .7rem; border-radius: .5rem; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); background: transparent; color: inherit; }
  input { flex: 1; }
  button { cursor: pointer; }
  #join { position: fixed; inset: 0; display: grid; place-items: center; background: color-mix(in srgb, canvas 82%, transparent); }
  #join form { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: .75rem; padding: 1rem; }
</style>
</head>
<body>
<header><strong>App Harness</strong><span class="notice">fallback room — the product UI is unavailable; chat and the feed remain live</span><span id="status" class="notice">connecting…</span></header>
<main>
  <section id="chat" aria-live="polite"></section>
  <aside><div id="queue"></div><div id="feed"></div></aside>
</main>
<form id="composer"><input id="text" autocomplete="off" placeholder="Message the room" aria-label="Message"><button type="submit">Send</button></form>
<div id="join" hidden><form id="joinForm"><label>Pick a display name<br><input id="name" maxlength="64" autocomplete="nickname"></label><button type="submit">Join</button><p id="joinError" role="alert"></p></form></div>
<script>
(() => {
  const chat = document.getElementById("chat"), feed = document.getElementById("feed"), queue = document.getElementById("queue");
  const status = document.getElementById("status"), join = document.getElementById("join"), joinError = document.getElementById("joinError");
  const seen = new Set(); const feedSeen = new Map();
  let socket;
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function addChat(m) { const key = "c" + m.seq; if (m.seq && seen.has(key)) return; if (m.seq) seen.add(key); const row = el("div", "msg"); row.append(el("b", "", m.author + ":"), document.createTextNode(m.text)); chat.append(row); chat.scrollTop = chat.scrollHeight; }
  function renderFeed(items) { for (const item of items || []) { if (feedSeen.has(item.seq)) continue; feedSeen.set(item.seq, true); feed.prepend(el("div", "feed-item", item.text)); } }
  function renderQueue(chips) { queue.replaceChildren(); for (const chip of chips || []) queue.append(el("span", "chip", chip.label)); }
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(proto + "//" + location.host + "/api/rooms/main");
    socket.addEventListener("open", () => { status.textContent = "live"; });
    socket.addEventListener("close", () => {
      status.textContent = "reconnecting…";
      // The worker rejects an expired or missing session at the HTTP layer
      // (401), which surfaces here as a plain close. Re-check the session
      // before reconnecting so an expired cookie re-shows the join dialog
      // instead of looping a silent reconnect forever.
      fetch("/api/session").then((r) => {
        if (r.ok) { setTimeout(connect, 1500); return; }
        status.textContent = "signed out";
        join.hidden = false;
      }).catch(() => setTimeout(connect, 1500));
    });
    socket.addEventListener("message", ({ data }) => {
      try {
        const event = JSON.parse(data);
        if (event.type === "room:snapshot") { (event.chat || []).forEach(addChat); renderFeed(event.feed && event.feed.items); renderQueue(event.feed && event.feed.queue); }
        if (event.type === "chat:message") addChat(event);
        if (event.type === "feed:update") { renderQueue(event.queue); renderFeed(event.items); }
        if (event.type === "room:notice") feed.prepend(el("div", "feed-item", "· " + event.text));
      } catch {}
    });
  }
  document.getElementById("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("text"); const text = input.value.trim();
    if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "chat:send", text })); input.value = "";
  });
  document.getElementById("joinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("name").value.trim();
    const response = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    if (!response.ok) { joinError.textContent = await response.text(); return; }
    join.hidden = true; connect();
  });
  fetch("/api/session").then((r) => { if (r.ok) connect(); else join.hidden = false; }).catch(() => { join.hidden = false; });
})();
</script>
</body>
</html>`;
