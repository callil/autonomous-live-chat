const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;

export const RUN_STATES = ["queued", "running", "verifying", "merged", "failed", "parked"];
export const TERMINAL_RUN_STATES = new Set(["merged", "failed", "parked"]);
export const ACTIVE_RUN_STATES = new Set(["running", "verifying"]);

/**
 * The hard run TTL (v1 scope ruling #20): a run past this wall-clock budget
 * is parked with an honest explanation and the queue advances. This replaces
 * all lease machinery.
 */
export const RUN_TTL_MS = 10 * 60_000;

/**
 * The honest-ETA planning number: serial capacity is 10-15 runs/hour, so one
 * run averages about five minutes end to end. ETAs are estimates rendered as
 * estimates — the chip templates say "~".
 */
export const AVERAGE_RUN_MS = 5 * 60_000;

function identifier(value, label) {
	if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} must be a bounded identifier.`);
	return value;
}

function timestamp(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer timestamp.`);
	return value;
}

function requireRun(queue, runId) {
	const run = queue.find((entry) => entry.runId === runId);
	if (!run) throw new Error(`Unknown run: ${runId}.`);
	return run;
}

function replaceRun(queue, updated) {
	return queue.map((entry) => (entry.runId === updated.runId ? updated : entry));
}

/** The single in-flight run, if any. Strictly at most one by construction. */
export function activeRun(queue) {
	return queue.find((entry) => ACTIVE_RUN_STATES.has(entry.state)) ?? null;
}

/** Queued runs in strict FIFO order. */
export function queuedRuns(queue) {
	return queue.filter((entry) => entry.state === "queued");
}

/**
 * Strict FIFO admission. One intent maps to one run; there is NO coalescing,
 * NO leasing, and NO stacking in v1 (scope ruling #20) — a duplicate runId or
 * a second run for the same intent is a caller bug, loudly.
 */
export function enqueueRun(queue, { runId, intentId, enqueuedAt }) {
	identifier(runId, "Run ID");
	identifier(intentId, "Intent ID");
	timestamp(enqueuedAt, "Enqueue timestamp");
	if (queue.some((entry) => entry.runId === runId)) throw new Error(`Run ${runId} is already recorded.`);
	if (queue.some((entry) => entry.intentId === intentId && !TERMINAL_RUN_STATES.has(entry.state))) throw new Error(`Intent ${intentId} already has a non-terminal run.`);
	return [...queue, { runId, intentId, state: "queued", enqueuedAt }];
}

/**
 * The only run eligible to start: the FIFO head, and only while nothing is
 * active. Singleton dispatch is the design, not an implementation detail —
 * one run at a time, branched from latest main, is what catches semantic
 * intent collisions that no file-level machinery can.
 */
export function nextDispatch(queue) {
	if (activeRun(queue)) return null;
	return queuedRuns(queue)[0] ?? null;
}

/**
 * queued -> running. Every start mints a fresh attempt ID: results are only
 * accepted from the recorded attempt, so a zombie process from a parked
 * attempt pushes inertly forever.
 */
export function startRun(queue, { runId, attemptId, startedAt }) {
	identifier(attemptId, "Attempt ID");
	timestamp(startedAt, "Start timestamp");
	const run = requireRun(queue, runId);
	if (run.state !== "queued") throw new Error(`Run ${runId} is ${run.state}, not queued.`);
	const eligible = nextDispatch(queue);
	if (!eligible || eligible.runId !== runId) throw new Error(`Run ${runId} is not the dispatchable head of the queue.`);
	return replaceRun(queue, { ...run, state: "running", attemptId, startedAt });
}

/**
 * Zombie-proofing: any externally pushed result must name the recorded
 * attempt. A missing or mismatched attempt ID means the push came from a
 * superseded process and must be inert.
 */
export function assertLiveAttempt(queue, { runId, attemptId }) {
	const run = requireRun(queue, runId);
	if (!ACTIVE_RUN_STATES.has(run.state)) throw new Error(`Run ${runId} is ${run.state}; late results are inert.`);
	if (run.attemptId !== attemptId) throw new Error(`Run ${runId} attempt mismatch: a superseded attempt's push is inert.`);
	return run;
}

/** running -> verifying. */
export function beginVerifying(queue, { runId, attemptId, at }) {
	timestamp(at, "Verifying timestamp");
	const run = assertLiveAttempt(queue, { runId, attemptId });
	if (run.state !== "running") throw new Error(`Run ${runId} is ${run.state}, not running.`);
	return replaceRun(queue, { ...run, state: "verifying", verifyingAt: at });
}

/** running|verifying -> merged|failed, attempt-guarded. */
export function completeRun(queue, { runId, attemptId, state, at, detail }) {
	timestamp(at, "Completion timestamp");
	if (state !== "merged" && state !== "failed") throw new Error("A run completes as merged or failed.");
	const run = assertLiveAttempt(queue, { runId, attemptId });
	return replaceRun(queue, { ...run, state, completedAt: at, ...(detail === undefined ? {} : { detail }) });
}

/**
 * TTL enforcement (park-and-explain): an active run past RUN_TTL_MS is
 * parked so the queue advances. Returns the parked run so the caller can
 * record the honest ledger fact and consult the Doctor seam.
 */
export function parkExpiredRun(queue, now, ttlMs = RUN_TTL_MS) {
	timestamp(now, "Clock");
	const run = activeRun(queue);
	if (!run || typeof run.startedAt !== "number" || now - run.startedAt < ttlMs) return { queue, parked: null };
	return { queue: replaceRun(queue, { ...run, state: "parked", completedAt: now, detail: "run-ttl-exceeded" }), parked: run };
}

/**
 * Honest queue state for the feed: 1-based position and a moving ETA derived
 * from the fixed average-run estimate plus the active run's remaining budget.
 * Deterministic in (queue, now) — the same facts always render the same chip.
 */
export function queueStatus(queue, now, averageRunMs = AVERAGE_RUN_MS) {
	timestamp(now, "Clock");
	const active = activeRun(queue);
	const activeRemainingMs = active && typeof active.startedAt === "number" ? Math.max(0, averageRunMs - (now - active.startedAt)) : 0;
	return queuedRuns(queue).map((run, index) => ({
		runId: run.runId,
		intentId: run.intentId,
		position: index + 1,
		etaMs: activeRemainingMs + index * averageRunMs,
	}));
}

/** Bound the stored record: terminal runs beyond the newest `keep` are pruned (their history lives in the ledger). */
export function pruneTerminalRuns(queue, keep = 20) {
	const terminal = queue.filter((entry) => TERMINAL_RUN_STATES.has(entry.state));
	const excess = terminal.length - keep;
	if (excess <= 0) return queue;
	const drop = new Set(terminal.slice(0, excess).map((entry) => entry.runId));
	return queue.filter((entry) => !drop.has(entry.runId));
}

/**
 * The room's daily spend gate, enforced at dispatch. Estimates are honest
 * constants until real metering lands in phase 2.
 */
export function withinDailyBudget({ spentUsd, budgetUsd, estimatedRunUsd }) {
	for (const [value, label] of [[spentUsd, "Spent"], [budgetUsd, "Budget"], [estimatedRunUsd, "Estimate"]]) {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number.`);
	}
	return spentUsd + estimatedRunUsd <= budgetUsd;
}
