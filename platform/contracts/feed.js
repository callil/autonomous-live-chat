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
	"intent-retried": (payload) => `Intent ${payload.intentId} gets one fresh build (run ${payload.runId}) — Doctor: ${clip(payload.note, 200)}`,
	"run-queued": (payload) => `Run ${payload.runId} queued for intent ${payload.intentId}.`,
	"run-started": (payload) => `Run ${payload.runId} started building.`,
	"run-heartbeat": () => null, // Progress facts are durable but not feed lines.
	"run-timing": () => null, // Measurement facts are durable but not feed lines.
	"run-verifying": (payload) => `Run ${payload.runId} pushed ${clip(payload.branch, 60) || "its branch"}${Number.isSafeInteger(payload.prNumber) ? ` (PR #${payload.prNumber})` : ""} — CI is verifying.`,
	"pr-merged": (payload) => `PR #${payload.prNumber} squash-merged at ${payload.mergeSha.slice(0, 7)} for run ${payload.runId}.`,
	"run-merged": (payload) => `Run ${payload.runId} is live${typeof payload.mergeSha === "string" ? ` at ${payload.mergeSha.slice(0, 7)}` : ""} — the deploy was observed serving.`,
	"run-failed": (payload) => `Run ${payload.runId} failed: ${clip(payload.reason, 200)}`,
	"run-parked": (payload) => `Run ${payload.runId} was parked: ${clip(payload.note, 200) || "it exceeded its budget; the queue advanced."}`,
	"deploy-requested": (payload) => `Deploy requested for ${payload.sha.slice(0, 7)}.`,
	"deploy-observed": (payload) => `Deploy observed serving ${payload.sha.slice(0, 7)}.`,
	"rollback-requested": (payload) => `Rollback requested to ${payload.sha.slice(0, 7)}: ${clip(payload.reason, 160)}`,
	"rollback-observed": (payload) => `Rolled back — observed serving ${payload.sha.slice(0, 7)} again.`,
	"liveness-failed": (payload) => `Liveness check failed against the live app (${clip(payload.reason, 120)}).`,
	"room-frozen": () => "The room is frozen by its owner: requests pause, chat stays open.",
	"room-unfrozen": () => "The room is unfrozen: requests resume.",
	"revert-requested": (payload) => `Owner requested a revert to ${payload.sha.slice(0, 7)}.`,
	"budget-exhausted": () => "Today's build budget is spent — queued work resumes after the daily reset.",
	"doctor-note": (payload) => `Doctor: ${clip(payload.note, 240)}`,
};

/**
 * Structured provenance refs for feed items that point at real external
 * artifacts (PRs, commits). Purely mechanical projections of the payload —
 * the product UI renders them as links, and because they come from the same
 * durable facts as the text, they cannot disagree with it.
 */
const REFS = {
	"run-verifying": (payload) => (Number.isSafeInteger(payload.prNumber) ? { prNumber: payload.prNumber } : null),
	"pr-merged": (payload) => ({ prNumber: payload.prNumber, sha: payload.mergeSha }),
	"run-merged": (payload) => (typeof payload.mergeSha === "string" ? { sha: payload.mergeSha } : null),
	"deploy-requested": (payload) => ({ sha: payload.sha }),
	"deploy-observed": (payload) => ({ sha: payload.sha }),
	"rollback-requested": (payload) => ({ sha: payload.sha }),
	"rollback-observed": (payload) => ({ sha: payload.sha }),
	"revert-requested": (payload) => ({ sha: payload.sha }),
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
	if (text === null) return null;
	const refs = REFS[event.kind]?.(event.payload) ?? null;
	return { seq: event.seq, at: event.at, kind: event.kind, text, ...(refs === null ? {} : { refs }) };
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
