const TERMINAL = new Set(["completed", "needs_review", "rejected"]);

// A state record carrying different artifacts is a different effect: without
// this, a later record that merges late artifacts (for example the CI
// validation reference) would deduplicate against an earlier bare record and
// silently never apply.
function artifactsTag(artifacts) {
	if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts) || Object.keys(artifacts).length === 0) return "";
	const canonical = JSON.stringify(sortValue(artifacts));
	let hash = 5381;
	for (let index = 0; index < canonical.length; index += 1) hash = ((hash * 33) ^ canonical.charCodeAt(index)) >>> 0;
	return `:a${hash.toString(16)}`;
}

function sortValue(value) {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).toSorted().map((key) => [key, sortValue(value[key])]));
	return value;
}

export function operatorActionEffectKey(workItemId, command) {
	if (command.kind === "classify") return `${workItemId}:classification`;
	if (command.kind === "create-issue") return `${workItemId}:issue`;
	if (command.kind === "plan") return `${workItemId}:plan:${command.plan.revision}`;
	if (command.kind === "implement") return `${workItemId}:implementation:${command.runId}`;
	if (command.kind === "record-candidate") return `${workItemId}:candidate:${command.runId}`;
	if (command.kind === "promote") return `${workItemId}:promotion:${command.dispatchKey}`;
	if (command.kind === "record-state") return `${workItemId}:state:${command.phase}${artifactsTag(command.artifacts)}`;
	throw new Error("Unknown operator command.");
}

/**
 * Safety/state invariant, not orchestration: the model still chooses what to
 * do, while the sole ledger refuses an impossible or out-of-order side effect.
 * These phase guards plus the semantic effect keys above are the correctness
 * guarantee; the per-item OperatorTurn Durable Object is the concurrency one.
 */
export function assertOperatorCommandAllowed(workItem, command) {
	if (TERMINAL.has(workItem.phase)) throw new Error("Terminal work cannot accept another operator action.");
	if (command.kind === "classify") {
		if (workItem.phase !== "submitted" || workItem.classification !== null) throw new Error("Classification is only the next action for submitted work without a classification.");
		return;
	}
	if (command.kind === "create-issue") {
		if (workItem.phase !== "classified" || workItem.classification?.decision !== "eligible" || workItem.artifacts.issue !== undefined) throw new Error("A GitHub issue requires one eligible classification and no existing issue artifact.");
		return;
	}
	if (command.kind === "plan") {
		if (workItem.classification?.decision !== "eligible" || workItem.artifacts.issue === undefined) throw new Error("A plan requires eligible classified work and its existing GitHub issue.");
		// The same replan points the ledger mutation accepts: a failed or stale
		// generation must be restackable, never wedged behind a dead run.
		const plannable = (workItem.phase === "classified" && workItem.plan === null)
			|| (workItem.phase === "delegated" && !workItem.activeImplementation)
			|| workItem.phase === "candidate"
			|| workItem.phase === "validating"
			|| workItem.phase === "retryable";
		if (!plannable) throw new Error("A plan is only the next action for classified work or a failed candidate to restack.");
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
		if (workItem.artifacts.validation?.conclusion !== "success") throw new Error("Promotion requires a successful validation. Validation failed or is unfinished: stage a revised plan (next revision, next generation, fresh baseSha) to restack the candidate.");
		return;
	}
	if (command.kind === "record-state") return;
	throw new Error("Unknown operator command.");
}

const PHASE_ORDER = ["submitted", "classified", "delegated", "implementing", "candidate", "validating", "promoting", "deployed", "completed"];

export function operatorCommandEffectSatisfied(workItem, command) {
	if (command.kind === "classify") return workItem.classification !== null;
	if (command.kind === "create-issue") return workItem.artifacts.issue !== undefined;
	if (command.kind === "plan") return workItem.plan?.revision === command.plan.revision;
	if (command.kind === "implement") return workItem.activeImplementation?.runId === command.runId;
	if (command.kind === "record-candidate") return workItem.artifacts.candidate?.runId === command.runId;
	if (command.kind === "promote") return false;
	if (command.kind === "record-state") {
		if (workItem.phase === command.phase) return true;
		const current = PHASE_ORDER.indexOf(workItem.phase);
		const expected = PHASE_ORDER.indexOf(command.phase);
		return current >= 0 && expected >= 0 && current >= expected;
	}
	return false;
}
