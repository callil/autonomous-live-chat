/** Display names allow spaces (session-contract shape); ids do not. */
const DISPLAY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u;
const SHA = /^[0-9a-f]{40}$/u;

/**
 * Every durable fact the Room ledger records. The ledger is append-only with a
 * monotonic sequence: nothing is ever rewritten or summarized away, and the
 * feed is a pure projection over these records.
 */
export const LEDGER_EVENT_KINDS = [
	// Conversation facts.
	"utterance",
	// A Target/Comment/Draw envelope, stored with its FULL verbatim payload
	// (data-loc ref, captured DOM snapshot, computed styles, drawing points,
	// screenshot crop). Evidence is never summarized away.
	"annotation",
	// Request lifecycle: the immediate public ack (with its cancel deadline)
	// and an in-window cancellation.
	"request-accepted",
	"request-cancelled",
	// Intent lifecycle facts. An intent is a versioned pointer into this
	// ledger, never a frozen ticket.
	"intent-opened",
	"intent-amended",
	"intent-dispatched",
	"intent-live",
	"intent-parked",
	"intent-withdrawn",
	// The Doctor granted a parked-course intent its one fresh run (phase 3).
	"intent-retried",
	// Run lifecycle facts (strict FIFO singleton runs).
	"run-queued",
	"run-started",
	// The builder's step heartbeats, recorded as durable progress facts. They
	// never render in the feed and never substitute for a terminal fact.
	"run-heartbeat",
	// Per-phase wall-clock durations reported by the builder at the end of a
	// run (boot/clone/agent/test/push ms) plus the tier it ran at. A pure
	// measurement fact: it never renders in the feed and never gates anything,
	// but it makes the fast path's cost breakdown durable and auditable.
	"run-timing",
	"run-verifying",
	// The platform's exact-SHA squash merge landed on main.
	"pr-merged",
	"run-merged",
	"run-failed",
	"run-parked",
	// Deploy facts: "live" is only ever an observation, never an intention.
	// A requested deploy or rollback is recorded as a request; "observed" is
	// reserved for the platform seeing the /version endpoint actually serve it.
	"deploy-requested",
	"deploy-observed",
	"rollback-requested",
	"rollback-observed",
	// The post-deploy liveness watchdog's synthetic fetch failed — a public
	// fact, and the trigger for the deterministic auto-revert.
	"liveness-failed",
	// Owner control facts.
	"room-frozen",
	"room-unfrozen",
	"revert-requested",
	// Honest resource facts: a dispatch refused by the spend budget is a
	// recorded, visible state, not a silent stall.
	"budget-exhausted",
	// The Doctor's public status note for cases with no intent to park
	// (for example a liveness failure across a migration deploy).
	"doctor-note",
	// Feedback about the HARNESS ITSELF (its toolbar, panel, composer). The
	// platform is firewalled from the room's coding agents by design, so this
	// fact is terminal at creation: recorded verbatim with its anchored
	// overlay element, surfaced honestly, and NEVER dispatched as a build.
	// The harness team reads these from the ledger and improves the overlay
	// on its own rails.
	"harness-feedback",
];

const KIND_SET = new Set(LEDGER_EVENT_KINDS);

function timestamp(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer timestamp.`);
	return value;
}

function sequence(value, label) {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer sequence.`);
	return value;
}

export function isLedgerEventKind(value) {
	return typeof value === "string" && KIND_SET.has(value);
}

/**
 * The annotation payload contract: required anchor fields are validated, and
 * everything else rides through VERBATIM. Callil's explicit requirement
 * (2026-08-08): the element selector, data-loc ref, captured DOM subtree,
 * computed styles, drawing points, and screenshot crop are stored exactly as
 * captured and never summarized away. This function therefore returns the
 * SAME object it was given — validation only, no normalization, no stripping.
 */
export function validateAnnotationPayload(payload) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Annotation payload must be an object.");
	if (payload.kind !== "target" && payload.kind !== "comment" && payload.kind !== "draw") throw new Error("Annotation kind must be target, comment, or draw.");
	if (typeof payload.dataLoc !== "string" || !payload.dataLoc.length) throw new Error("Annotation must carry its data-loc ref.");
	if (typeof payload.domSnapshot !== "string" || !payload.domSnapshot.length) throw new Error("Annotation must carry its captured DOM snapshot verbatim.");
	if (payload.kind === "draw" && !Array.isArray(payload.drawingPoints)) throw new Error("A draw annotation must carry its drawing points.");
	if (payload.kind === "comment" && (typeof payload.text !== "string" || !payload.text.trim().length)) throw new Error("A comment annotation must carry its text.");
	return payload;
}

/**
 * Validates and freezes one ledger event. Payload objects pass through by
 * reference (annotations are stored verbatim); the event envelope itself is
 * what this contract owns.
 */
export function createLedgerEvent({ seq, kind, at, payload }) {
	sequence(seq, "Event sequence");
	if (!isLedgerEventKind(kind)) throw new Error(`Unknown ledger event kind: ${String(kind)}.`);
	timestamp(at, "Event timestamp");
	if (payload === undefined || payload === null || typeof payload !== "object") throw new Error("Event payload must be an object.");
	if (kind === "annotation") validateAnnotationPayload(payload.annotation);
	if (kind === "utterance") {
		if (typeof payload.author !== "string" || !DISPLAY_NAME.test(payload.author)) throw new Error("Utterance author must be a bounded display name.");
		if (typeof payload.text !== "string" || !payload.text.length) throw new Error("Utterance text must be a non-empty string.");
	}
	if ((kind === "revert-requested" || kind === "rollback-requested" || kind === "deploy-requested" || kind === "deploy-observed" || kind === "rollback-observed") && (typeof payload.sha !== "string" || !SHA.test(payload.sha))) throw new Error(`A ${kind} fact must carry a full Git SHA.`);
	if (kind === "pr-merged" && (typeof payload.mergeSha !== "string" || !SHA.test(payload.mergeSha))) throw new Error("A pr-merged fact must carry the squash-merge commit SHA.");
	return Object.freeze({ seq, kind, at, payload });
}

/**
 * Append-only discipline: an event may only follow the exact previous
 * sequence. The Durable Object's single-threaded transaction supplies
 * lastSeq; this guard makes a skipped or repeated sequence a loud error
 * instead of a silent hole in history.
 */
export function assertAppendable(lastSeq, event) {
	if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) throw new Error("Last sequence must be a non-negative integer.");
	if (event.seq !== lastSeq + 1) throw new Error(`Ledger append out of order: expected seq ${lastSeq + 1}, got ${event.seq}.`);
	return event;
}

/** Fixed-width storage key so lexicographic list order equals sequence order. */
export function eventStorageKey(seq) {
	sequence(seq, "Event sequence");
	return `event:${String(seq).padStart(12, "0")}`;
}
