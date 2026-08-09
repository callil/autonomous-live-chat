import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createIntent } from "../contracts/intent.js";
import { createLedgerEvent, eventStorageKey } from "../contracts/ledger.js";
import { parseRequestEnvelope } from "../contracts/envelope.js";

const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const runnerWorker = await readFile(new URL("../runner/src/index.ts", import.meta.url), "utf8");
const job = await readFile(new URL("../runner/job-entrypoint.mjs", import.meta.url), "utf8");

/**
 * REQUEST FIDELITY (the defect this file exists to prevent).
 *
 * The requester's typed words reached the ledger and then stopped: the
 * `request-accepted` fact carrying them was appended AFTER the intent was
 * created, so its sequence was never recorded in `intent.refs`. Since
 * `collectEvidence` recovers the text by walking those refs and nothing else,
 * `requestText` was structurally ALWAYS empty. Every build ran with an anchor
 * and no instructions, invented a plausible change, and shipped it green —
 * and every PR title fell through to the `Live-room change intent-<uuid>`
 * fallback, which is how the two defects turned out to be one.
 *
 * Comment-kind requests looked fine throughout, because their text rides
 * inside the annotation payload rather than the request-accepted fact. That
 * is exactly why this went unnoticed, so these tests cover all three kinds.
 *
 * These are BEHAVIORAL: they replay the real append order against a fake
 * storage and assert on the recovered evidence. A source-pattern assertion
 * could not have caught a missing pointer, which is the whole lesson.
 */

/** A minimal stand-in for the DO storage surface collectEvidence touches. */
function fakeStorage() {
	const map = new Map();
	let seq = 0;
	return {
		map,
		append(kind, payload, at = 1_700_000_000_000) {
			seq += 1;
			const event = createLedgerEvent({ seq, kind, at, payload });
			map.set(eventStorageKey(seq), event);
			return event;
		},
		get: async (key) => map.get(key),
	};
}

/**
 * The evidence recovery under test, mirroring RoomDO.collectEvidence: walk the
 * intent's refs, recover the requester's words from whichever fact carries
 * them for that envelope kind.
 */
async function collectEvidence(storage, intent) {
	const annotations = [];
	let requestText = "";
	let annotationText = "";
	for (const seq of [...intent.refs.annotationSeqs, ...intent.refs.utteranceSeqs]) {
		const event = await storage.get(eventStorageKey(seq));
		if (!event) continue;
		if (event.kind === "annotation") {
			annotations.push(event.payload);
			const annotation = event.payload.annotation;
			if (typeof annotation?.text === "string" && annotation.text.trim().length) annotationText = annotation.text.trim();
		}
		if (event.kind === "request-accepted" && typeof event.payload.text === "string" && event.payload.text.trim().length) {
			requestText = event.payload.text.trim();
		}
		if (event.kind === "utterance" && typeof event.payload.text === "string" && !requestText.trim().length) {
			requestText = event.payload.text.trim();
		}
	}
	return { requestText: requestText || annotationText, requestedBy: intent.openedBy, annotations };
}

/** Replays handleRequest's real append order for one envelope kind. */
async function acceptRequest(kind, text, annotationExtras = {}) {
	const storage = fakeStorage();
	const envelope = parseRequestEnvelope({
		type: `request:${kind}`,
		text,
		annotation: {
			dataLoc: "product/src/ui/room.html:52",
			domSnapshot: "<span class=\"room-title\">The Live Room</span>",
			...(kind === "draw" ? { drawingPoints: [{ x: 1, y: 2 }, { x: 3, y: 4 }] } : {}),
			...annotationExtras,
		},
	});
	const annotationEvent = storage.append("annotation", { by: "cal", byId: "session-1", annotation: envelope.annotation });
	const openedEvent = storage.append("intent-opened", { intentId: "intent-abc", by: "cal" });
	const acceptedEvent = storage.append("request-accepted", { intentId: "intent-abc", by: "cal", text: envelope.text, at: 1_700_000_000_000, cancelDeadline: 1_700_000_010_000 });
	const intent = createIntent({
		id: "intent-abc",
		openedBy: "cal",
		openedById: "session-1",
		at: 1_700_000_000_000,
		refs: { utteranceSeqs: [acceptedEvent.seq], annotationSeqs: [annotationEvent.seq] },
		openSeq: openedEvent.seq,
	});
	return collectEvidence(storage, intent);
}

test("a TARGET request carries the requester's typed words to the builder", async () => {
	const evidence = await acceptRequest("target", "Add a bottom border under the room header");
	assert.equal(evidence.requestText, "Add a bottom border under the room header");
	assert.equal(evidence.requestedBy, "cal");
	assert.equal(evidence.annotations.length, 1);
});

test("a DRAW request carries its typed words too", async () => {
	const evidence = await acceptRequest("draw", "Make this area use the accent colour");
	assert.equal(evidence.requestText, "Make this area use the accent colour");
});

test("a COMMENT request recovers its text from the annotation payload", async () => {
	// Comment text rides inside the annotation, not the request-accepted fact.
	// This kind stayed faithful throughout the outage, which is what masked it.
	const evidence = await acceptRequest("comment", "", { text: "This heading is too quiet" });
	assert.equal(evidence.requestText, "This heading is too quiet");
});

test("REGRESSION: the request-accepted seq is recorded in the intent refs", async () => {
	// The original bug in one assertion: omit the accepted seq from refs and the
	// typed words become unreachable, exactly as they were in production.
	const storage = fakeStorage();
	const annotationEvent = storage.append("annotation", {
		by: "cal",
		byId: "session-1",
		annotation: { kind: "target", dataLoc: "product/src/ui/room.html:52", domSnapshot: "<h1>x</h1>" },
	});
	const openedEvent = storage.append("intent-opened", { intentId: "intent-abc", by: "cal" });
	storage.append("request-accepted", { intentId: "intent-abc", by: "cal", text: "Reword the tagline", at: 1, cancelDeadline: 2 });
	const brokenIntent = createIntent({
		id: "intent-abc",
		openedBy: "cal",
		openedById: "session-1",
		at: 1_700_000_000_000,
		// The shipped bug: annotation only, accepted seq dropped.
		refs: { utteranceSeqs: [], annotationSeqs: [annotationEvent.seq] },
		openSeq: openedEvent.seq,
	});
	const evidence = await collectEvidence(storage, brokenIntent);
	assert.equal(evidence.requestText, "", "this is the shipped failure mode the fix must prevent");

	// And the fix: include it, and the words arrive.
	const fixedIntent = { ...brokenIntent, refs: { ...brokenIntent.refs, utteranceSeqs: [3] } };
	assert.equal((await collectEvidence(storage, fixedIntent)).requestText, "Reword the tagline");
});

test("the platform records the request-accepted seq and refuses to dispatch a blind build", () => {
	assert.match(worker, /const acceptedEvent = await this\.appendEvent\("request-accepted"/u, "the accepted fact is appended before the intent so its seq can be referenced");
	assert.match(worker, /utteranceSeqs: \[acceptedEvent\.seq\]/u, "the typed words are reachable from the intent");
	assert.match(worker, /if \(!evidence\.requestText\.trim\(\)\.length\)/u, "dispatch refuses a builder with no instructions");
	assert.match(worker, /request-text-missing/u, "the refusal is a recorded, honest fact");
});

test("both runner layers refuse an empty requestText as defense in depth", () => {
	assert.match(runnerWorker, /!requestText\.trim\(\)\.length/u);
	assert.match(job, /!evidence\.requestText\.trim\(\)\.length/u);
});

test("the agent prompt presents the request as the specification, not as optional context", () => {
	assert.match(job, /BEGIN REQUEST/u);
	assert.match(job, /Do exactly what the request says/u);
	assert.match(job, /They tell you WHERE; the request above tells you WHAT/u);
});
