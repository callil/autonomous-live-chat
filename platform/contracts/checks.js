/**
 * Deterministic CI-verdict classification (v1 scope ruling #20: ONE suite CI,
 * no risk tiers). The platform reads the check runs GitHub recorded for the
 * exact head SHA and classifies them mechanically — no model, no judgment.
 */

const GREEN_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const RED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);

/**
 * One check run -> one bounded record. Anything outside the shape GitHub
 * documents is treated as pending, never as green.
 */
function normalizeCheckRun(value) {
	if (!value || typeof value !== "object") return null;
	const name = typeof value.name === "string" ? value.name.slice(0, 120) : "unnamed-check";
	const status = typeof value.status === "string" ? value.status : "unknown";
	const conclusion = typeof value.conclusion === "string" ? value.conclusion : null;
	return { name, status, conclusion };
}

/**
 * Classify the full set of check runs for a head SHA:
 * - "green"   — at least one check exists and every one completed with a
 *               passing conclusion. Zero checks is NOT green: a revision no
 *               CI ever looked at must never merge.
 * - "red"     — any check completed with a failing conclusion; failed names
 *               ride along for the park-and-explain note.
 * - "pending" — anything else (queued, in progress, or no checks reported yet).
 */
export function classifyCheckRuns(checkRuns) {
	if (!Array.isArray(checkRuns)) throw new Error("Check runs must be an array.");
	const runs = checkRuns.map(normalizeCheckRun).filter((run) => run !== null);
	const failed = runs.filter((run) => run.status === "completed" && RED_CONCLUSIONS.has(run.conclusion ?? ""));
	if (failed.length) return { verdict: "red", failed: failed.map((run) => run.name) };
	if (runs.length && runs.every((run) => run.status === "completed" && GREEN_CONCLUSIONS.has(run.conclusion ?? ""))) return { verdict: "green" };
	return { verdict: "pending" };
}

/**
 * Deterministic migration marker: a merged diff that touched a migrations
 * surface makes the deploy non-auto-revertible (task #20: auto-rollback
 * refuses when the deploy included a migration; the Doctor gets it instead).
 * Derived from the ACTUAL changed-file list the platform read from GitHub,
 * never from anything the model claimed.
 */
export function includesMigrationMarker(changedPaths) {
	if (!Array.isArray(changedPaths)) throw new Error("Changed paths must be an array.");
	return changedPaths.some((path) => typeof path === "string" && (/(^|\/)migrations?\//iu.test(path) || /migration/iu.test(path.split("/").pop() ?? "")));
}
