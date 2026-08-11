/**
 * User-requested run mode (the successor to automatic effort tiering).
 *
 * The automatic small/normal tier classifier is gone by owner decision: the
 * measured runs showed low effort did not reduce wall clock, so silent
 * downgrades traded quality for nothing. The system never sizes a run on its
 * own again — every run builds at full quality unless the REQUESTER explicitly
 * asks for speed on that one request.
 *
 * "fast" is an informed, per-request user choice carried on the request
 * envelope (the composer offers the control; the platform only relays it).
 * It tunes the agent's own budgets — lower reasoning effort, a tighter tool
 * ceiling, no repository tree in the prompt, and the final self-review stays
 * a CHECK but skips the fix-it iteration. It never changes what may be
 * written, never skips the local gate, and never skips CI.
 *
 * Honesty rule: a fast result must always be LABELED fast — in the feed row,
 * the queue chip, and the PR — so nobody mistakes it for the system's best.
 * A fast pass that disappoints needs nothing special to redo: a follow-up
 * request at standard mode ("polish this") is just another intent.
 *
 * The mode is recorded on the run-started and run-timing ledger facts so
 * outcome and duration by mode stay measurable.
 */

export const RUN_MODES = ["standard", "fast"];

/** Only an explicit "fast" is fast; everything else is standard. Never guess cheap — or fast. */
export function normalizeRunMode(value) {
	return value === "fast" ? "fast" : "standard";
}

/**
 * Budgets per mode. Standard is the system's best: full reasoning effort for
 * this agent, the full tool ceiling, the repository tree, and a self-review
 * that may iterate once to close gaps. Fast trades those down explicitly.
 */
export const MODE_BUDGETS = {
	standard: { effort: "medium", maxToolCalls: 12, includeTree: true, selfReview: "iterate" },
	fast: { effort: "low", maxToolCalls: 8, includeTree: false, selfReview: "check" },
};

/** The agent budgets for a mode. Unknown modes take the standard (full-quality) budget. */
export function modeBudgets(mode) {
	return MODE_BUDGETS[mode] ?? MODE_BUDGETS.standard;
}
