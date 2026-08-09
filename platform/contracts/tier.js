/**
 * Deterministic run sizing (the fast path, task #20-compatible).
 *
 * A request is classified from FACTS the platform already holds — the envelope
 * kind, the length and shape of the request text, and the anchor count — never
 * from a model's opinion. The tier only tunes the agent's own budgets
 * (reasoning effort, tool-call ceiling, whether the repository tree rides the
 * prompt); it never changes what may be written, never skips the local gate,
 * and never skips CI. A misclassified "small" therefore costs at most one
 * cheap failed attempt, which the Doctor may retry at the normal tier.
 *
 * The tier is recorded on the run-started ledger fact so error rates by tier
 * stay measurable.
 */

export const RUN_TIERS = ["small", "normal"];

/**
 * Small runs are the style/copy class: a single anchored element and a short
 * instruction. These bounds are deliberately conservative — the cost of
 * calling a large change "small" is a wasted attempt, so the gate is tight.
 */
export const SMALL_MAX_TEXT_CHARS = 240;
export const SMALL_MAX_ANNOTATIONS = 1;

/** Budgets per tier. Normal reproduces today's behaviour exactly. */
export const TIER_BUDGETS = {
	small: { effort: "low", maxToolCalls: 6, includeTree: false },
	normal: { effort: "medium", maxToolCalls: 12, includeTree: true },
};

/**
 * Phrases that mean "this is not a one-element tweak" even inside a short
 * sentence. A request that sweeps the whole surface is never small, however
 * few characters it takes to ask for it.
 */
const BREADTH_MARKERS = /\b(all|every|everything|entire|throughout|globally|across|each|consistent(?:ly)?|everywhere|whole|site-wide|sitewide|app-wide|refactor|redesign|rewrite|restructure|migrate|rename)\b/iu;

/**
 * Multi-part requests ("do X and also Y", "X, then Y") are not small: the
 * tight tool budget cannot honestly carry two edits plus their verification.
 */
const CONJUNCTION_MARKERS = /(?:\balso\b|\bthen\b|\bplus\b|\bas well as\b|;|\n\s*[-*\d]\s)/iu;

/**
 * Classify one request into a run tier from durable facts alone.
 *
 * `annotationCount` is the number of anchors carried by the intent; a small
 * run must point at exactly one place. Returns "normal" for anything it cannot
 * positively prove is small — the safe direction.
 */
export function classifyRunTier({ kind, text, annotationCount }) {
	if (kind !== "target" && kind !== "comment" && kind !== "draw") return "normal";
	if (!Number.isSafeInteger(annotationCount) || annotationCount < 1 || annotationCount > SMALL_MAX_ANNOTATIONS) return "normal";
	const value = typeof text === "string" ? text.trim() : "";
	// A draw carries its instruction in the strokes, not in prose; without text
	// there is nothing to bound, so it takes the normal budget.
	if (!value.length) return "normal";
	if (value.length > SMALL_MAX_TEXT_CHARS) return "normal";
	if (BREADTH_MARKERS.test(value)) return "normal";
	if (CONJUNCTION_MARKERS.test(value)) return "normal";
	return "small";
}

/** The agent budgets for a tier. Unknown tiers fall back to normal. */
export function tierBudgets(tier) {
	return TIER_BUDGETS[tier] ?? TIER_BUDGETS.normal;
}
