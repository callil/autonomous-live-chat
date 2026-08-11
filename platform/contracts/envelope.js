import { validateAnnotationPayload } from "./ledger.js";
import { normalizeRunMode } from "./mode.js";

/**
 * The SOLE request trigger (v1 non-negotiable, task #20): an explicit
 * Target/Comment/Draw envelope. Plain chat is chat — there is no
 * per-utterance change-request classification; that was our own recorded
 * lesson.
 */
export const REQUEST_ENVELOPE_TYPES = ["request:target", "request:comment", "request:draw"];

const ENVELOPE_KINDS = { "request:target": "target", "request:comment": "comment", "request:draw": "draw" };

/**
 * Every accepted request acks immediately and then holds for this window
 * before it may dispatch, so a slip of the finger is one click to undo.
 */
export const CANCEL_WINDOW_MS = 10_000;

/**
 * Parses one client websocket message into a request envelope. Returns null
 * for anything that is not a request envelope (chat, history paging, and so
 * on stay ordinary messages). Throws when a message CLAIMS to be a request
 * envelope but is malformed — a half-request must be refused loudly, never
 * silently treated as chat.
 */
export function parseRequestEnvelope(message) {
	if (!message || typeof message !== "object" || Array.isArray(message)) return null;
	const kind = ENVELOPE_KINDS[message.type];
	if (!kind) return null;
	const annotation = validateAnnotationPayload({ ...(typeof message.annotation === "object" && message.annotation !== null ? message.annotation : {}), kind });
	const text = typeof message.text === "string" ? message.text.trim() : "";
	if (kind === "target" && !text.length) throw new Error("A target request must carry its request text.");
	return {
		kind,
		text: kind === "comment" ? annotation.text : text,
		annotation,
		// The requester's explicit speed choice for THIS request. Only a literal
		// "fast" is fast; the system never downgrades a run on its own.
		mode: normalizeRunMode(message.mode),
		clientSubmissionId: typeof message.clientSubmissionId === "string" && message.clientSubmissionId.length <= 128 ? message.clientSubmissionId : undefined,
	};
}

/** The cancel deadline recorded on the public ack. */
export function cancelDeadline(acceptedAt, windowMs = CANCEL_WINDOW_MS) {
	if (!Number.isSafeInteger(acceptedAt) || acceptedAt < 0) throw new Error("Accepted timestamp must be a non-negative integer.");
	return acceptedAt + windowMs;
}

/** An accepted request may only dispatch once its cancel window has fully elapsed. */
export function mayDispatch(acceptedAt, now, windowMs = CANCEL_WINDOW_MS) {
	if (!Number.isSafeInteger(now) || now < 0) throw new Error("Clock must be a non-negative integer.");
	return now >= cancelDeadline(acceptedAt, windowMs);
}
