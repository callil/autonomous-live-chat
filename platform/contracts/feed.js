import { queueStatus } from "./queue.js";

/**
 * The feed is a PURE PROJECTION of durable ledger facts through fixed
 * templates. No model output ever enters this truth path: user-authored text
 * is quoted verbatim as user speech, everything else is deterministic
 * template text keyed on the event kind. Same facts in, same feed out.
 */

function clip(value, max = 140) {
	const text = typeof value === "string" ? value : "";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "~4 min" style honest-estimate label; estimates always read as estimates. */
export function formatEta(etaMs) {
	if (!Number.isFinite(etaMs) || etaMs < 0) throw new Error("ETA must be a non-negative number of milliseconds.");
	if (etaMs < 60_000) return "under a minute";
	return `~${Math.round(etaMs / 60_000)} min`;
}

const TEMPLATES = {
	"utterance": (payload) => null, // Chat renders in the chat lane, not the feed.
	"annotation": (payload) => `${payload.by} marked ${clip(payload.annotation?.dataLoc, 80)} (${payload.annotation?.kind}).`,
	"request-accepted": (payload) => `Request ${payload.intentId} accepted from ${payload.by} — cancellable for ${Math.round((payload.cancelDeadline - payload.at) / 1000)}s: “${clip(payload.text)}”`,
	"request-cancelled": (payload) => `Request ${payload.intentId} cancelled by ${payload.by} inside its cancel window.`,
	"intent-opened": (payload) => `Intent ${payload.intentId} opened by ${payload.by}.`,
	"intent-amended": (payload) => `Intent ${payload.intentId} amended by ${payload.by} (v${payload.version}).`,
	"intent-dispatched": (payload) => `Intent ${payload.intentId} dispatched as run ${payload.runId}.`,
	"intent-live": (payload) => `Intent ${payload.intentId} is live.`,
	"intent-parked": (payload) => `Intent ${payload.intentId} parked: ${clip(payload.reason, 200)}`,
	"intent-withdrawn": (payload) => `Intent ${payload.intentId} withdrawn.`,
	"run-queued": (payload) => `Run ${payload.runId} queued for intent ${payload.intentId}.`,
	"run-started": (payload) => `Run ${payload.runId} started building.`,
	"run-verifying": (payload) => `Run ${payload.runId} is verifying.`,
	"run-merged": (payload) => `Run ${payload.runId} merged${typeof payload.headSha === "string" ? ` at ${payload.headSha.slice(0, 7)}` : ""}.`,
	"run-failed": (payload) => `Run ${payload.runId} failed: ${clip(payload.reason, 200)}`,
	"run-parked": (payload) => `Run ${payload.runId} exceeded its 10-minute budget and was parked; the queue advanced.`,
	"deploy-observed": (payload) => `Deploy observed serving ${typeof payload.sha === "string" ? payload.sha.slice(0, 7) : "a new revision"}.`,
	"rollback-observed": (payload) => `Rolled back to ${typeof payload.sha === "string" ? payload.sha.slice(0, 7) : "the previous good revision"}.`,
	"room-frozen": () => "The room is frozen by its owner: requests pause, chat stays open.",
	"room-unfrozen": () => "The room is unfrozen: requests resume.",
	"revert-requested": (payload) => `Owner requested a revert to ${payload.sha.slice(0, 7)}.`,
	"budget-exhausted": () => "Today's build budget is spent — queued work resumes after the daily reset.",
};

/**
 * One event -> one feed line (or null for events that do not project, like
 * chat utterances). Unknown kinds throw: a fact the feed cannot render
 * honestly is a contract violation, not a silent omission.
 */
export function renderFeedItem(event) {
	const template = TEMPLATES[event.kind];
	if (!template) throw new Error(`No feed template for ledger event kind: ${String(event.kind)}.`);
	const text = template(event.payload);
	return text === null ? null : { seq: event.seq, at: event.at, kind: event.kind, text };
}

/** Honest queue chips: position and moving ETA for every queued run. */
export function renderQueueChips(queue, now) {
	return queueStatus(queue, now).map((entry) => ({
		...entry,
		label: `#${entry.position} in line · ${formatEta(entry.etaMs)}`,
	}));
}

/**
 * The complete feed payload: projected items plus embedded honest queue
 * state. Deterministic in its inputs.
 */
export function renderFeed({ events, queue, now, frozen }) {
	return {
		items: events.map(renderFeedItem).filter((item) => item !== null),
		queue: renderQueueChips(queue, now),
		frozen: frozen === true,
	};
}
