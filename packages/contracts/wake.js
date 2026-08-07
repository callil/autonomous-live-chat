export function queueOperatorWakeRecord(existing, input) {
	const availableAt = input.now + Math.max(0, input.delayMs);
	if (existing?.state === "in_flight") {
		return { ...existing, nextVersion: Math.max(existing.nextVersion ?? existing.version, input.version) };
	}
	if (existing?.version === input.version) {
		return { ...existing, turn: existing.turn ?? 1, state: existing.state ?? "pending", availableAt: Math.min(existing.availableAt, availableAt) };
	}
	// A fresh record must never reuse an already-delivered turn number for the
	// same revision: the external gateway deduplicates by version and turn, so
	// a reset counter would silently swallow the next prompt.
	return { id: input.id, workItemId: input.workItemId, version: input.version, turn: Math.max(1, input.turnFloor ?? 1), state: "pending", attempts: 0, availableAt };
}

export function settleOperatorWakeRecord(wake, input) {
	if (!wake || wake.state !== "in_flight" || wake.version !== input.expectedVersion || (wake.turn ?? 1) !== input.turn) return undefined;
	if (input.currentVersion < input.expectedVersion) return undefined;
	if (input.terminal || input.currentVersion === input.expectedVersion) return null;
	return { id: wake.id, workItemId: wake.workItemId, version: input.currentVersion, turn: Math.max(1, input.turn) + 1, state: "pending", attempts: 0, availableAt: input.now };
}

export function beginOperatorWakeDelivery(wake, input) {
	if (input.terminal) return null;
	let current = wake;
	if (current.state === "in_flight" || input.currentVersion !== current.version) {
		current = { ...current, version: input.currentVersion, turn: (current.turn ?? 1) + 1, state: "pending", availableAt: input.now, nextVersion: undefined };
	}
	return { ...current, turn: current.turn ?? 1, state: "in_flight", attempts: current.attempts + 1, availableAt: input.now + input.responseLeaseMs, nextVersion: undefined };
}

export function operatorWakeDeliveryExhausted(wake, maximumAttempts) {
	return Number.isSafeInteger(maximumAttempts) && maximumAttempts > 0 && wake.attempts >= maximumAttempts;
}
