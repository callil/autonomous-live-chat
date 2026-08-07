const TERMINAL = new Set(["completed", "needs_review", "rejected"]);

export function operatorActionEffectKey(workItemId, command) {
	if (command.kind === "classify") return `${workItemId}:classification`;
	if (command.kind === "create-issue") return `${workItemId}:issue`;
	if (command.kind === "plan") return `${workItemId}:plan:${command.plan.revision}`;
	if (command.kind === "implement") return `${workItemId}:implementation:${command.runId}`;
	if (command.kind === "record-candidate") return `${workItemId}:candidate:${command.runId}`;
	if (command.kind === "promote") return `${workItemId}:promotion:${command.dispatchKey}`;
	if (command.kind === "record-state") return `${workItemId}:state:${command.phase}`;
	if (command.kind === "claim") return `${workItemId}:claim:${command.leaseId}`;
	if (command.kind === "release") return `${workItemId}:release:${command.leaseId}`;
	return `${workItemId}:defer:${command.leaseId}:${command.delayMs}`;
}

/**
 * Safety/state invariant, not orchestration: the model still chooses what to
 * do, while the sole ledger refuses an impossible or out-of-order side effect.
 */
export function assertOperatorCommandAllowed(workItem, command, now) {
	if (TERMINAL.has(workItem.phase)) throw new Error("Terminal work cannot accept another operator action.");
	if (command.kind === "claim") {
		if (workItem.lease && workItem.lease.expiresAt > now) throw new Error("This work item already has a live operator lease.");
		return;
	}
	if (command.kind === "release" || command.kind === "defer") return;
	if (command.kind === "classify") {
		if (workItem.phase !== "claimed" || workItem.classification !== null) throw new Error("Classification is only the next action for claimed work without a classification.");
		return;
	}
	if (command.kind === "create-issue") {
		if (workItem.phase !== "classified" || workItem.classification?.decision !== "eligible" || workItem.artifacts.issue !== undefined) throw new Error("A GitHub issue requires one eligible classification and no existing issue artifact.");
		return;
	}
	if (command.kind === "plan") {
		if (workItem.phase !== "classified" || workItem.classification?.decision !== "eligible" || workItem.plan !== null || workItem.artifacts.issue === undefined) throw new Error("A plan requires eligible classified work and its existing GitHub issue.");
		return;
	}
	if (command.kind === "implement") {
		if (workItem.phase !== "delegated" || workItem.plan === null) throw new Error("Implementation requires the accepted durable stack plan.");
		return;
	}
	if (command.kind === "record-candidate") {
		if (workItem.phase !== "implementing" || workItem.activeImplementation?.runId !== command.runId) throw new Error("A candidate must match the active implementation run.");
		return;
	}
	if (command.kind === "promote") {
		if (workItem.phase !== "validating" || workItem.artifacts.validation === undefined) throw new Error("Promotion requires a validated immutable candidate.");
		return;
	}
	if (command.kind === "record-state") return;
	throw new Error("Unknown operator command.");
}

const PHASE_ORDER = ["submitted", "claimed", "classified", "delegated", "implementing", "candidate", "validating", "promoting", "deployed", "completed"];

export function operatorCommandEffectSatisfied(workItem, command) {
	if (command.kind === "claim") return workItem.lease?.id === command.leaseId;
	if (command.kind === "release") return workItem.lease === null;
	if (command.kind === "defer") return workItem.resumeAt !== null && workItem.resumeAt !== undefined;
	if (command.kind === "classify") return workItem.classification !== null;
	if (command.kind === "create-issue") return workItem.artifacts.issue !== undefined;
	if (command.kind === "plan") return workItem.plan?.revision === command.plan.revision;
	if (command.kind === "implement") return workItem.activeImplementation?.runId === command.runId;
	if (command.kind === "record-candidate") return workItem.artifacts.candidate?.runId === command.runId;
	if (command.kind === "promote") return false;
	if (command.kind === "record-state") {
		const current = PHASE_ORDER.indexOf(workItem.phase);
		const expected = PHASE_ORDER.indexOf(command.phase);
		return current >= 0 && expected >= 0 && current >= expected;
	}
	return false;
}
