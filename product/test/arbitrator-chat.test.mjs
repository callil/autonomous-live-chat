import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSandbox, runScript } from "../../platform/test/support/dom.mjs";

const html = await readFile(new URL("../src/ui/room.html", import.meta.url), "utf8");
const client = await readFile(new URL("../src/ui/room.client.js", import.meta.url), "utf8");

async function joinedRoom() {
	const harness = createSandbox({ html });
	runScript(client, harness.sandbox);
	harness.fetches.at(-1).respond({ ok: true, json: async () => ({ id: "s1", name: "Ada" }) });
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	harness.sockets[0].emit("open", {});
	return harness;
}

function rowText(row) {
	return row.descendants().map((element) => element.textContent).join(" ");
}

test("Arbitrator answers feature-use questions as a participant in main chat", async () => {
	const { document, sockets } = await joinedRoom();
	sockets[0].deliver({ type: "chat:message", seq: 1, author: "Ada", text: "How do reactions work?", at: 1_700_000_000_000 });

	const rows = document.getElementById("messages").children;
	assert.equal(rows.length, 2);
	assert.match(rowText(rows.at(-1)), /Arbitrator/u);
	assert.match(rowText(rows.at(-1)), /double-click/u);
});

test("Arbitrator uses room progress facts when answering build questions", async () => {
	const { document, sockets } = await joinedRoom();
	sockets[0].deliver({ type: "feed:update", items: [{ kind: "run-verifying", title: "CI is checking the change", at: 1_700_000_000_000 }] });
	sockets[0].deliver({ type: "chat:message", seq: 2, author: "Ada", text: "What's the build progress?", at: 1_700_000_000_001 });

	const reply = document.getElementById("messages").children.at(-1);
	assert.match(rowText(reply), /Arbitrator/u);
	assert.match(rowText(reply), /CI is verifying/u);
});
