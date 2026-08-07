/**
 * Load-readiness contracts: the merge-train admission gate and the room-level
 * model-credit health fact. Both are pure transforms over one plain
 * serializable record each — a counter-and-set for implementation slots and a
 * single boolean fact for credits — so the room Durable Object owns nothing
 * here but persistence and transactions.
 */

/**
 * Concurrent work items allowed to hold an implementation-to-merge slot.
 * Three slots against eight sandboxes keeps candidates from racing each other
 * into hot-file merge conflicts: admission is serialized before runs start,
 * so doomed runs are never spawned instead of being retried after the fact.
 */
export const IMPLEMENT_SLOTS = 3;

function boundedIds(value) {
	return Array.isArray(value) ? [...new Set(value.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 128))] : [];
}

/**
 * The one durable admission record: `holders` is the slot set, `queue` is the
 * honest arrival-ordered wait list, and `announced` remembers the last queue
 * position published per item so the public feed only speaks on change.
 */
export function normalizeAdmissionState(value) {
	const raw = value && typeof value === "object" ? value : {};
	const holders = boundedIds(raw.holders);
	const queue = boundedIds(raw.queue).filter((id) => !holders.includes(id));
	const announced = {};
	if (raw.announced && typeof raw.announced === "object" && !Array.isArray(raw.announced)) {
		for (const [id, position] of Object.entries(raw.announced)) {
			if (queue.includes(id) && Number.isSafeInteger(position) && position >= 1) announced[id] = position;
		}
	}
	return { holders, queue, announced };
}

/**
 * Grant an implementation-to-merge slot, or register the item in the wait
 * queue. Granting is idempotent for a current holder; a grant to a queued
 * item removes it from the queue. A refused grant reports the item's queue
 * position (1-based) and how many items are queued ahead of it.
 */
export function grantImplementSlot(state, workItemId, slots = IMPLEMENT_SLOTS) {
	const current = normalizeAdmissionState(state);
	if (current.holders.includes(workItemId)) return { granted: true, state: current };
	if (current.holders.length < slots) {
		const announced = { ...current.announced };
		delete announced[workItemId];
		return {
			granted: true,
			state: {
				holders: [...current.holders, workItemId],
				queue: current.queue.filter((id) => id !== workItemId),
				announced,
			},
		};
	}
	const queue = current.queue.includes(workItemId) ? current.queue : [...current.queue, workItemId];
	const position = queue.indexOf(workItemId) + 1;
	return { granted: false, state: { ...current, queue }, position, ahead: position - 1 };
}

/**
 * Release whatever the item holds: its slot, or its place in the queue when
 * it went terminal while waiting. Returns released: false when the item held
 * nothing, so callers can skip the follow-up queue announcements.
 */
export function releaseImplementSlot(state, workItemId) {
	const current = normalizeAdmissionState(state);
	if (!current.holders.includes(workItemId) && !current.queue.includes(workItemId)) return { released: false, state: current };
	const announced = { ...current.announced };
	delete announced[workItemId];
	return {
		released: true,
		state: {
			holders: current.holders.filter((id) => id !== workItemId),
			queue: current.queue.filter((id) => id !== workItemId),
			announced,
		},
	};
}

/** 1-based queue position, or null when the item is not waiting. */
export function implementQueuePosition(state, workItemId) {
	const index = normalizeAdmissionState(state).queue.indexOf(workItemId);
	return index === -1 ? null : index + 1;
}

/**
 * The two classifications that mean the model account is out of credits: the
 * coding agent's non-retryable failure and the operator loop's health note.
 * Both trace back to the provider's 429 insufficient_quota error.
 */
const CREDIT_EXHAUSTION_CLASSIFICATIONS = new Set(["agent-credits-exhausted", "model-credits-exhausted"]);

export function isCreditsExhaustedClassification(value) {
	return typeof value === "string" && CREDIT_EXHAUSTION_CLASSIFICATIONS.has(value);
}

/**
 * Record the room-level credit outage. Idempotent: a repeated report keeps
 * the original timestamp and reports changed: false so the public
 * announcement is spoken exactly once per outage.
 */
export function recordCreditsExhausted(health, at) {
	if (health && typeof health === "object" && health.creditsExhausted === true) {
		return { health: { creditsExhausted: true, at: Number.isSafeInteger(health.at) ? health.at : at }, changed: false };
	}
	return { health: { creditsExhausted: true, at }, changed: true };
}

/** Clear the outage; changed: true only when an outage was actually recorded. */
export function clearCreditsExhausted(health) {
	return { health: null, changed: Boolean(health && typeof health === "object" && health.creditsExhausted === true) };
}
