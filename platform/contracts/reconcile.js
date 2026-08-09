import { mayDispatch } from "./envelope.js";
import { activeRun, nextDispatch, parkExpiredRun, withinDailyBudget } from "./queue.js";

/**
 * The reconciler's decision policy as a PURE function of durable state
 * (spine doctrine: decide(snapshot) -> steps; the Room DO executes them).
 * Level-triggered: it never trusts why it woke — the same snapshot always
 * yields the same ordered plan, so every waiting phase has a mechanical
 * reconciliation edge and fixture tests can replay recorded snapshots.
 *
 * Snapshot shape (all durable facts, no I/O):
 * - now            clock
 * - frozen         owner freeze lever
 * - queue          QueuedRun[]
 * - openIntents    intents still in state "open": [{ id, openedAt }]
 * - budget         { spentUsd, budgetUsd, estimatedRunUsd }
 * - revert         null | { sha, dispatchedAt: number | null }  (owner revert-to-SHA, bypasses the pipeline)
 * - watchdog       null | { sha, until, migration }              (post-deploy liveness window)
 * - doctorQueue    pending park cases awaiting the Doctor's verdict (phase 3)
 */
export function decide(snapshot) {
	const { now, frozen, queue, openIntents, budget, revert, watchdog, doctorQueue } = snapshot;
	if (!Number.isSafeInteger(now) || now < 0) throw new Error("Snapshot clock must be a non-negative integer.");
	if (!Array.isArray(queue) || !Array.isArray(openIntents)) throw new Error("Snapshot queue and openIntents must be arrays.");
	const actions = [];

	// 1. Owner revert-to-SHA outranks everything: it bypasses the request
	// pipeline entirely and runs even while a build is active.
	if (revert && typeof revert.sha === "string") {
		actions.push(revert.dispatchedAt === null
			? { kind: "dispatch-revert", sha: revert.sha }
			: { kind: "observe-revert", sha: revert.sha });
	}

	// 2. One pending Doctor case resolves per cycle. The consult happens in
	// the reconciler — never inline in a client-driven push handler, where a
	// disconnect could cancel it halfway — so a crash mid-consult simply
	// re-presents the same durable case next cycle.
	if (Array.isArray(doctorQueue) && doctorQueue.length > 0) {
		actions.push({ kind: "consult-doctor" });
	}

	// 3. TTL enforcement: park-and-explain, then the queue advances. The
	// swept view drives the rest of this cycle so a parked head frees the
	// lane immediately.
	const { queue: swept, parked } = parkExpiredRun(queue, now);
	if (parked) actions.push({ kind: "park-run", runId: parked.runId, intentId: parked.intentId, phase: parked.state });

	// 4. Enqueue accepted requests whose cancel window has elapsed.
	for (const intent of openIntents) {
		if (mayDispatch(intent.openedAt, now)) actions.push({ kind: "enqueue-intent", intentId: intent.id });
	}

	// 5. Drive the single active run's current waiting phase.
	const active = activeRun(swept);
	if (active?.state === "verifying" && active.verification) {
		actions.push({ kind: "observe-ci", runId: active.runId, attemptId: active.attemptId, prNumber: active.verification.prNumber, headSha: active.verification.headSha });
	}
	if (active?.state === "deploying" && typeof active.mergeSha === "string") {
		actions.push({ kind: "observe-deploy", runId: active.runId, attemptId: active.attemptId, mergeSha: active.mergeSha });
	}
	// state === "running" needs no action: the runner reports by push and the
	// TTL in step 2 is the backstop.

	// 6. Post-deploy liveness watchdog: inside the window, every cycle does a
	// synthetic fetch of the product. Suppressed while a revert is already in
	// flight — one deterministic recovery at a time.
	if (!revert && watchdog && Number.isSafeInteger(watchdog.until) && now < watchdog.until) {
		actions.push({ kind: "liveness-check", sha: watchdog.sha, migration: watchdog.migration === true });
	}

	// 7. Dispatch the FIFO head — one run at a time, never while frozen or
	// while the lane is busy, never past the daily spend budget.
	if (!frozen && !active) {
		const head = nextDispatch(swept);
		if (head) {
			actions.push(withinDailyBudget(budget)
				? { kind: "dispatch", runId: head.runId, intentId: head.intentId }
				: { kind: "announce-budget-exhausted" });
		}
	}

	return actions;
}
