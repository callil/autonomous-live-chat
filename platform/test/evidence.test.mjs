import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createIntent } from "../contracts/intent.js";
import { createLedgerEvent, eventStorageKey } from "../contracts/ledger.js";
import { parseRequestEnvelope } from "../contracts/envelope.js";

/**
 * EVIDENCE RECOVERY — executed from the SHIPPING source, not a copy of it.
 *
 * `collectEvidence` is the function that carries a requester's typed words to
 * the coding agent. When it was broken, `requestText` was structurally always
 * "": every build ran with an anchor and no instructions, invented a plausible
 * change, and shipped it green. That path had zero tests.
 *
 * request-fidelity.test.mjs covers the same defect, but against a
 * REIMPLEMENTATION of collectEvidence written inside the test file. That is a
 * latent false green of its own: the shipping method can drift from the test's
 * copy and the test keeps passing. This file closes that hole by lifting the
 * real method out of platform/src/index.ts and executing it, so the behaviour
 * under test is the behaviour that ships.
 */

const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

/**
 * Extract the real `collectEvidence` body and make it callable.
 *
 * The worker is a Cloudflare module with types and bindings, so it cannot be
 * imported in Node. Lifting the one method by source keeps this test bound to
 * the shipping implementation: if the method is renamed, restructured, or
 * deleted, this fails loudly rather than silently testing a stale copy.
 */
async function loadCollectEvidence() {
	const signature = "private async collectEvidence(";
	const start = worker.indexOf(signature);
	assert.notEqual(start, -1, "collectEvidence must exist in the platform worker");
	// The signature carries an object return type, so the method body is the
	// brace that opens the first statement — find it past the `{` of that type.
	const bodyStart = worker.indexOf("{\n", worker.indexOf("Promise<", start));
	const open = bodyStart;
	assert.notEqual(open, -1, "collectEvidence must have a body");
	let depth = 0;
	let end = -1;
	for (let index = open; index < worker.length; index += 1) {
		if (worker[index] === "{") depth += 1;
		if (worker[index] === "}") {
			depth -= 1;
			if (depth === 0) {
				end = index + 1;
				break;
			}
		}
	}
	assert.ok(end > open, "collectEvidence must be a well-formed method body");

	const body = worker
		.slice(open, end)
		// Strip the TypeScript the method carries; the logic itself is plain JS.
		.replaceAll("const annotations: unknown[] = []", "const annotations = []")
		.replaceAll('let mode: RunMode = "standard"', 'let mode = "standard"')
		.replaceAll("await this.ctx.storage.get<LedgerEvent>(", "await storage.get(")
		.replaceAll(" as { text?: unknown } | undefined", "");

	assert.ok(!body.includes("LedgerEvent"), "every typed storage read must be rewired to the fake storage");
	assert.ok(!body.includes("this.ctx"), "the lifted method must not reach for durable-object internals");
	assert.ok(body.includes("storage.get("), "the lifted method must read through the injected storage");

	const module = await import(
		`data:text/javascript,${encodeURIComponent(
			`import { eventStorageKey } from ${JSON.stringify(new URL("../contracts/ledger.js", import.meta.url).href)};\n` +
				`export async function collectEvidence(storage, intent) ${body}\n`,
		)}`
	);
	return module.collectEvidence;
}

const collectEvidence = await loadCollectEvidence();

/** A stand-in for the DO storage surface collectEvidence reads through. */
function fakeStorage() {
	const map = new Map();
	let seq = 0;
	return {
		append(kind, payload, at = 1_700_000_000_000) {
			seq += 1;
			const event = createLedgerEvent({ seq, kind, at, payload });
			map.set(eventStorageKey(seq), event);
			return event;
		},
		get: async (key) => map.get(key),
	};
}

/** Replay handleRequest's real append order for one envelope kind. */
function acceptRequest(kind, text, annotationExtras = {}) {
	const storage = fakeStorage();
	const envelope = parseRequestEnvelope({
		type: `request:${kind}`,
		text,
		annotation: {
			dataLoc: "product/src/ui/room.html:52",
			domSnapshot: '<span class="room-title">The Live Room</span>',
			...(kind === "draw" ? { drawingPoints: [{ x: 1, y: 2 }] } : {}),
			...annotationExtras,
		},
	});
	const annotationEvent = storage.append("annotation", { by: "cal", byId: "session-1", annotation: envelope.annotation });
	const openedEvent = storage.append("intent-opened", { intentId: "intent-abc", by: "cal" });
	const acceptedEvent = storage.append("request-accepted", {
		intentId: "intent-abc",
		by: "cal",
		text: envelope.text,
		at: 1_700_000_000_000,
		cancelDeadline: 1_700_000_010_000,
	});
	const intent = createIntent({
		id: "intent-abc",
		openedBy: "cal",
		openedById: "session-1",
		at: 1_700_000_000_000,
		refs: { utteranceSeqs: [acceptedEvent.seq], annotationSeqs: [annotationEvent.seq] },
		openSeq: openedEvent.seq,
	});
	return { storage, intent };
}

test("the shipping evidence path carries a TARGET request's typed words to the builder", async () => {
	const { storage, intent } = acceptRequest("target", "Add a bottom border under the room header");
	const evidence = await collectEvidence(storage, intent);
	assert.equal(evidence.requestText, "Add a bottom border under the room header");
	assert.equal(evidence.requestedBy, "cal");
	assert.equal(evidence.annotations.length, 1, "the anchor travels with the words");
});

test("the shipping evidence path carries a DRAW request's typed words", async () => {
	const { storage, intent } = acceptRequest("draw", "Make this area use the accent colour");
	assert.equal((await collectEvidence(storage, intent)).requestText, "Make this area use the accent colour");
});

test("a COMMENT request recovers its text from the annotation payload", async () => {
	// Comment text rides inside the annotation rather than the request-accepted
	// fact. That difference is exactly what masked the outage for this kind.
	const { storage, intent } = acceptRequest("comment", "", { text: "This heading is too quiet" });
	assert.equal((await collectEvidence(storage, intent)).requestText, "This heading is too quiet");
});

test("REGRESSION: dropping the accepted seq from refs makes the words unreachable", async () => {
	// The shipped bug in one assertion, run against the shipping code.
	const { storage, intent } = acceptRequest("target", "Reword the tagline");
	const blind = { ...intent, refs: { ...intent.refs, utteranceSeqs: [] } };
	assert.equal((await collectEvidence(storage, blind)).requestText, "", "this is the production failure mode: an anchor and no instructions");
	assert.equal((await collectEvidence(storage, intent)).requestText, "Reword the tagline", "and the fix restores them");
});

test("the request-accepted fact wins over an earlier plain utterance", async () => {
	// Untested before: a room where someone spoke, then targeted something. The
	// deliberate request must beat incidental speech, or the build follows the
	// wrong sentence.
	const storage = fakeStorage();
	const chatter = storage.append("utterance", { author: "cal", text: "hmm what about the header" });
	const annotation = storage.append("annotation", { by: "cal", byId: "s1", annotation: { kind: "target", dataLoc: "f:1", domSnapshot: "<h1>x</h1>" } });
	const opened = storage.append("intent-opened", { intentId: "i1", by: "cal" });
	const accepted = storage.append("request-accepted", { intentId: "i1", by: "cal", text: "Make the header bold", at: 1, cancelDeadline: 2 });
	const intent = createIntent({
		id: "i1",
		openedBy: "cal",
		openedById: "s1",
		at: 1_700_000_000_000,
		refs: { utteranceSeqs: [chatter.seq, accepted.seq], annotationSeqs: [annotation.seq] },
		openSeq: opened.seq,
	});
	assert.equal((await collectEvidence(storage, intent)).requestText, "Make the header bold");
});

test("a plain utterance is still recovered when there is no accepted fact", async () => {
	// The fallback path, also untested before: speech attached to an intent is
	// requester speech, and is better than dispatching blind.
	const storage = fakeStorage();
	const utterance = storage.append("utterance", { author: "cal", text: "please make it blue" });
	const opened = storage.append("intent-opened", { intentId: "i1", by: "cal" });
	const intent = createIntent({
		id: "i1",
		openedBy: "cal",
		openedById: "s1",
		at: 1_700_000_000_000,
		refs: { utteranceSeqs: [utterance.seq], annotationSeqs: [] },
		openSeq: opened.seq,
	});
	assert.equal((await collectEvidence(storage, intent)).requestText, "please make it blue");
});

test("evidence recovery tolerates refs pointing at events that are not there", async () => {
	// A ref to a missing or compacted event must skip, not throw: a throw here
	// takes down dispatch for the whole room.
	const { storage, intent } = acceptRequest("target", "Tighten the spacing");
	const gappy = { ...intent, refs: { utteranceSeqs: [intent.refs.utteranceSeqs[0], 9999], annotationSeqs: [4242] } };
	const evidence = await collectEvidence(storage, gappy);
	assert.equal(evidence.requestText, "Tighten the spacing");
	assert.equal(evidence.annotations.length, 0, "a missing anchor is skipped, not fabricated");
});

test("whitespace-only request text is treated as absent, so dispatch can refuse it", async () => {
	// The guard downstream is `!requestText.trim().length`. If recovery returned
	// "   " as if it were words, a blind build would dispatch again.
	const storage = fakeStorage();
	const annotation = storage.append("annotation", { by: "cal", byId: "s1", annotation: { kind: "target", dataLoc: "f:1", domSnapshot: "<h1>x</h1>" } });
	const opened = storage.append("intent-opened", { intentId: "i1", by: "cal" });
	const accepted = storage.append("request-accepted", { intentId: "i1", by: "cal", text: "   ", at: 1, cancelDeadline: 2 });
	const intent = createIntent({
		id: "i1",
		openedBy: "cal",
		openedById: "s1",
		at: 1_700_000_000_000,
		refs: { utteranceSeqs: [accepted.seq], annotationSeqs: [annotation.seq] },
		openSeq: opened.seq,
	});
	assert.equal((await collectEvidence(storage, intent)).requestText.trim().length, 0, "empty words must stay empty so the refusal fires");
});

test("the platform refuses to dispatch a build with no instructions", () => {
	// The last line of defence, and the reason the outage cannot recur silently:
	// no recoverable request means a recorded refusal, not a guessed change.
	assert.match(worker, /if \(!evidence\.requestText\.trim\(\)\.length\)/u, "dispatch checks the recovered words");
	assert.match(worker, /request-text-missing/u, "the refusal is a recorded, honest fact");
});

test("the shipping evidence path recovers the requester's explicit fast mode — and only fast", async () => {
	const storage = fakeStorage();
	const annotation = storage.append("annotation", { by: "cal", byId: "s1", annotation: { kind: "target", dataLoc: "f:1", domSnapshot: "<h1>x</h1>" } });
	const opened = storage.append("intent-opened", { intentId: "i2", by: "cal" });
	const accepted = storage.append("request-accepted", { intentId: "i2", by: "cal", text: "darken this", mode: "fast", at: 1, cancelDeadline: 2 });
	const intent = createIntent({
		id: "i2",
		openedBy: "cal",
		openedById: "s1",
		at: 1_700_000_000_000,
		refs: { utteranceSeqs: [accepted.seq], annotationSeqs: [annotation.seq] },
		openSeq: opened.seq,
	});
	assert.equal((await collectEvidence(storage, intent)).mode, "fast");
	// An accepted fact recorded before the mode field existed reads standard.
	const legacy = acceptRequest("target", "darken this");
	assert.equal((await collectEvidence(legacy.storage, legacy.intent)).mode, "standard");
});
