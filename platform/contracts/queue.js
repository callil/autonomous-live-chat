const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u;

export const RUN_STATES = ["queued", "running", "verifying", "deploying", "merged", "failed", "parked"];
export const TERMINAL_RUN_STATES = new Set(["merged", "failed", "parked"]);
export const ACTIVE_RUN_STATES = new Set(["running", "verifying", "deploying"]);

/**
 * The hard run TTL (v1 scope ruling #20): a run past this wall-clock budget
 * is parked with an honest explanation and the queue advances. This replaces
 * all lease machinery. Each phase carries its own budget from its own start
 * mark: a run that reached verifying earned a fresh CI budget, and a run that
 * reached deploying (already squash-merged) earned a fresh observation
 * budget — parking a merged change on the BUILD clock would be dishonest.
 */
export const RUN_TTL_MS = 10 * 60_000;
export const VERIFY_TTL_MS = 10 * 60_000;
export const DEPLOY_TTL_MS = 10 * 60_000;

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

/** The verification context the runner reports: what the platform verifies, merges, and deploys. */
export function validateVerification(value) {
	if (!value || typeof value !== "object") throw new Error("Verification context must be an object.");
	const { branch, prNumber, headSha } = value;
	if (typeof branch !== "string" || !BRANCH.test(branch) || branch.includes("..") || branch.startsWith("-") || branch.endsWith("/")) throw new Error("Verification must carry the pushed branch name.");
	if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error("Verification must carry the opened PR number.");
	if (typeof headSha !== "string" || !SHA.test(headSha)) throw new Error("Verification must carry the exact 40-hex head SHA.");
	return { branch, prNumber, headSha };
}

/**
 * running -> verifying. The runner reports {branch, prNumber, headSha}; from
 * here the PLATFORM owns the pipeline — it reads CI, merges at exactly that
 * head SHA, and observes the deploy. The exact SHA recorded now is the only
 * revision that may ever merge for this run.
 */
export function beginVerifying(queue, { runId, attemptId, at, verification }) {
	timestamp(at, "Verifying timestamp");
	const run = assertLiveAttempt(queue, { runId, attemptId });
	if (run.state !== "running") throw new Error(`Run ${runId} is ${run.state}, not running.`);
	return replaceRun(queue, { ...run, state: "verifying", verifyingAt: at, verification: validateVerification(verification) });
}

/**
 * verifying -> deploying: CI was green and the exact-SHA squash merge landed
 * as mergeSha. The change is now irreversibly on main; from here the run can
 * only complete merged (deploy observed serving) or park loudly — never fail
 * back into the queue as if the merge had not happened.
 */
export function beginDeploying(queue, { runId, attemptId, at, mergeSha, migration }) {
	timestamp(at, "Deploying timestamp");
	if (typeof mergeSha !== "string" || !SHA.test(mergeSha)) throw new Error("Deploying requires the squash-merge commit SHA.");
	const run = assertLiveAttempt(queue, { runId, attemptId });
	if (run.state !== "verifying") throw new Error(`Run ${runId} is ${run.state}, not verifying.`);
	// The migration marker (derived from the ACTUAL changed files) rides the
	// run record so the post-deploy watchdog knows auto-revert is refused.
	return replaceRun(queue, { ...run, state: "deploying", deployingAt: at, mergeSha, migration: migration === true });
}

/** running|verifying|deploying -> merged|failed, attempt-guarded. A deploying run never "fails": its merge already landed. */
export function completeRun(queue, { runId, attemptId, state, at, detail }) {
	timestamp(at, "Completion timestamp");
	if (state !== "merged" && state !== "failed") throw new Error("A run completes as merged or failed.");
	const run = assertLiveAttempt(queue, { runId, attemptId });
	if (state === "merged" && run.state !== "deploying") throw new Error(`Run ${runId} is ${run.state}; merged means the observed deploy of a squash-merged run, nothing earlier.`);
	if (state === "failed" && run.state === "deploying") throw new Error(`Run ${runId} is deploying; its merge already landed, so it parks loudly instead of failing.`);
	return replaceRun(queue, { ...run, state, completedAt: at, ...(detail === undefined ? {} : { detail }) });
}

/** Each active phase runs on its own clock from its own start mark. */
const PHASE_BUDGETS = [
	["running", "startedAt", () => RUN_TTL_MS],
	["verifying", "verifyingAt", (ttls) => ttls.verifyMs],
	["deploying", "deployingAt", (ttls) => ttls.deployMs],
];

/**
 * TTL enforcement (park-and-explain): an active run past its current phase's
 * wall-clock budget is parked so the queue advances. Returns the parked run
 * so the caller can record the honest ledger fact and consult the Doctor
 * seam. The detail names the phase that expired, because "the build hung"
 * and "the merge landed but the deploy was never observed" are different
 * public truths.
 */
export function parkExpiredRun(queue, now, ttlMs = RUN_TTL_MS, verifyMs = VERIFY_TTL_MS, deployMs = DEPLOY_TTL_MS) {
	timestamp(now, "Clock");
	const run = activeRun(queue);
	if (!run) return { queue, parked: null };
	const budget = PHASE_BUDGETS.find(([state]) => state === run.state);
	if (!budget) return { queue, parked: null };
	const [, startKey, pick] = budget;
	const start = run[startKey];
	if (typeof start !== "number" || now - start < (run.state === "running" ? ttlMs : pick({ verifyMs, deployMs }))) return { queue, parked: null };
	return { queue: replaceRun(queue, { ...run, state: "parked", completedAt: now, detail: `${run.state}-ttl-exceeded` }), parked: run };
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
