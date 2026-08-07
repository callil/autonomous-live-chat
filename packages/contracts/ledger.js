const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u;
const SHA = /^[0-9a-f]{40}$/u;

export const LEDGER_PHASES = [
	"submitted",
	"classified",
	"delegated",
	"implementing",
	"candidate",
	"validating",
	"promoting",
	"deployed",
	"completed",
	"retryable",
	"needs_review",
	"rejected",
];

export const TERMINAL_LEDGER_PHASES = new Set(["completed", "needs_review", "rejected"]);

function identifier(value, label) {
	if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} must be a bounded identifier.`);
	return value;
}

function timestamp(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer timestamp.`);
	return value;
}

function positiveInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
	return value;
}

function sha(value, label) {
	if (typeof value !== "string" || !SHA.test(value)) throw new Error(`${label} must be a full Git SHA.`);
	return value;
}

function branch(value, label) {
	if (typeof value !== "string" || !BRANCH.test(value) || value.includes("..") || value.endsWith("/") || value.startsWith("-")) {
		throw new Error(`${label} must be a safe Git branch name.`);
	}
	return value;
}

function next(item, phase, now, changes = {}) {
	if (!LEDGER_PHASES.includes(phase)) throw new Error("Unknown ledger phase.");
	return {
		...item,
		...changes,
		phase,
		version: item.version + 1,
		updatedAt: now,
	};
}

/**
 * Creates the sole durable control record for one public request. Detailed
 * events are stored as separate records keyed by work item and sequence so
 * neither history nor idempotency is hidden in an in-memory loop.
 *
 * Concurrency needs no lease: the per-item OperatorTurn Durable Object is
 * already serialized, and these phase guards plus semantic effect keys are the
 * correctness guarantee for whatever it stages.
 */
export function createLedgerWorkItem({ id, room, request, target, submissionId, now }) {
	return {
		schemaVersion: 1,
		id: identifier(id, "Work item ID"),
		room: identifier(room, "Room"),
		request,
		target,
		submissionId: submissionId === undefined ? undefined : identifier(submissionId, "Submission ID"),
		phase: "submitted",
		version: 1,
		classification: null,
		plan: null,
		activeImplementation: null,
		artifacts: {},
		createdAt: timestamp(now, "Creation time"),
		updatedAt: timestamp(now, "Update time"),
	};
}

export function recordLedgerClassification(item, { classification, now }) {
	const at = timestamp(now, "Classification time");
	if (item.phase !== "submitted") throw new Error("Only submitted work can be classified.");
	if (!classification || typeof classification !== "object") throw new Error("Classification is required.");
	if (!['eligible', 'needs_review', 'rejected'].includes(classification.decision)) throw new Error("Classification decision is invalid.");
	if (!['visual', 'content', 'data', 'behavior', 'infrastructure'].includes(classification.changeType)) throw new Error("Classification change type is invalid.");
	if (!['localized', 'bounded', 'broad'].includes(classification.scope)) throw new Error("Classification scope is invalid.");
	if (!['low', 'medium', 'high'].includes(classification.risk)) throw new Error("Classification risk is invalid.");
	if (!['ui', 'copy', 'data', 'behavior', 'infrastructure'].includes(classification.affectedSurface)) throw new Error("Classification affected surface is invalid.");
	if (typeof classification.reversible !== "boolean") throw new Error("Classification reversibility is invalid.");
	if (!['eligible', 'needs_review'].includes(classification.executionEligibility)) throw new Error("Classification execution eligibility is invalid.");
	if (!['visual', 'content', 'behavior', 'data', 'infrastructure'].includes(classification.ciProfile)) throw new Error("Classification CI profile is invalid.");
	if (classification.decision === 'eligible' && classification.executionEligibility !== 'eligible') throw new Error("Eligible classification must be execution eligible.");
	if (classification.decision !== 'eligible' && classification.executionEligibility === 'eligible') throw new Error("Blocked classification cannot be execution eligible.");
	const phase = classification.decision === "eligible" ? "classified" : classification.decision;
	return next(item, phase, at, { classification });
}

export function recordLedgerPlan(item, { plan, now }) {
	const at = timestamp(now, "Plan time");
	// A plan may be revised until a candidate has merged: classified work,
	// delegated work with no live run, and a candidate whose validation failed
	// (a restack) are all legal replan points.
	if (!(item.phase === "classified" || (item.phase === "delegated" && !item.activeImplementation) || item.phase === "candidate" || item.phase === "validating")) throw new Error("Only classified work can receive a plan.");
	if (!plan || typeof plan !== "object") throw new Error("Plan is required.");
	const issue = item.artifacts?.issue;
	if (!issue || !Number.isSafeInteger(issue.number) || issue.number < 1) throw new Error("A plan requires the existing GitHub issue artifact.");
	const normalized = {
		revision: positiveInteger(plan.revision, "Plan revision"),
		baseSha: sha(plan.baseSha, "Plan base"),
		stackId: identifier(plan.stackId, "Stack ID"),
		generation: positiveInteger(plan.generation, "Stack generation"),
		nodeId: identifier(plan.nodeId, "Stack node ID"),
		branch: branch(plan.branch, "Stack branch"),
		parentBranch: branch(plan.parentBranch, "Stack parent branch"),
		parentBaseSha: plan.parentBaseSha === null ? null : sha(plan.parentBaseSha, "Stack parent base"),
		pullRequestBase: branch(plan.pullRequestBase, "Pull request base"),
		issueNumber: positiveInteger(plan.issueNumber, "Issue number"),
		summary: plan.summary,
		ciProfile: identifier(plan.ciProfile, "CI profile"),
	};
	if (normalized.pullRequestBase !== normalized.parentBranch) throw new Error("The pull request base must be the stack parent branch.");
	if (normalized.issueNumber !== issue.number) throw new Error("The plan issue must match the durable GitHub issue artifact.");
	if (normalized.parentBranch !== "main" && normalized.parentBaseSha === null) throw new Error("A dependent stack node requires its parent's immutable head SHA.");
	if (normalized.nodeId === "root") {
		if (normalized.parentBranch !== "main") throw new Error("A root stack node's parentBranch must be main.");
		if (normalized.parentBaseSha === null) throw new Error("A root stack node requires parentBaseSha equal to the plan baseSha.");
		const canonical = `app-harness-os/${normalized.issueNumber}/g${normalized.generation}`;
		if (normalized.branch !== canonical) throw new Error(`A one-node stack branch must be exactly ${canonical}.`);
	} else {
		throw new Error("Only a one-node root stack plan is currently supported: nodeId must be root.");
	}
	if (item.plan && normalized.revision <= item.plan.revision) throw new Error(`A revised plan must use revision ${item.plan.revision + 1} or later.`);
	// A revised plan starts a fresh candidate lineage: stale candidate and
	// validation evidence from the previous generation must not survive it.
	const artifacts = { ...item.artifacts };
	delete artifacts.candidate;
	delete artifacts.validation;
	delete artifacts.pullRequestUrl;
	return next(item, "delegated", at, {
		plan: normalized,
		activeImplementation: null,
		artifacts,
	});
}

/**
 * The implementation key is deterministic for the accepted plan and base.
 * Before spawning a run, the operator checks this key and existing Git
 * artifacts. A retry with the same key resumes; it never starts over.
 */
export function implementationKey(item) {
	if (!item.plan) throw new Error("A plan is required before implementation.");
	return `${item.id}:p${item.plan.revision}:g${item.plan.generation}:${item.plan.baseSha}`;
}

export function startLedgerImplementation(item, { runId, now }) {
	const at = timestamp(now, "Implementation start time");
	if (!item.plan) throw new Error("A plan is required before implementation.");
	if (!["delegated", "implementing", "candidate"].includes(item.phase)) throw new Error("Only delegated work can start implementation.");
	const key = implementationKey(item);
	if (item.activeImplementation?.key === key) {
		return { disposition: "resume", item };
	}
	if (item.artifacts?.candidate?.implementationKey === key) {
		return { disposition: "artifact-exists", item };
	}
	return {
		disposition: "started",
		item: next(item, "implementing", at, {
			activeImplementation: {
				key,
				runId: identifier(runId, "Implementation run ID"),
				attempt: (item.activeImplementation?.attempt ?? 0) + 1,
				startedAt: at,
			},
		}),
	};
}

export function recordLedgerCandidate(item, { runId, branch: candidateBranch, headSha, pullRequestNumber, pullRequestUrl, now }) {
	const at = timestamp(now, "Candidate time");
	if (item.phase !== "implementing") throw new Error("Only an implementing work item can record a candidate.");
	if (!item.activeImplementation || item.activeImplementation.runId !== runId) throw new Error("Candidate does not match the active implementation run.");
	const normalizedBranch = branch(candidateBranch, "Candidate branch");
	if (!item.plan || normalizedBranch !== item.plan.branch) throw new Error("Candidate branch does not match the durable stack node.");
	let normalizedPullRequestUrl;
	try { normalizedPullRequestUrl = new URL(pullRequestUrl).toString(); } catch { throw new Error("Candidate pull request URL is invalid."); }
	if (!normalizedPullRequestUrl.startsWith("https://github.com/")) throw new Error("Candidate pull request must be hosted on GitHub.");
	const candidate = {
		implementationKey: item.activeImplementation.key,
		runId: identifier(runId, "Implementation run ID"),
		branch: normalizedBranch,
		headSha: sha(headSha, "Candidate head"),
		pullRequestNumber: positiveInteger(pullRequestNumber, "Pull request number"),
		pullRequestUrl: normalizedPullRequestUrl,
		pullRequestBase: item.plan.pullRequestBase,
		stackId: item.plan.stackId,
		generation: item.plan.generation,
		nodeId: item.plan.nodeId,
	};
	return next(item, "candidate", at, {
		activeImplementation: null,
		artifacts: { ...item.artifacts, candidate },
	});
}

export function recordLedgerExternalState(item, { phase, artifacts = {}, now }) {
	const at = timestamp(now, "External-state time");
	if (!['validating', 'promoting', 'deployed', 'completed', 'retryable', 'needs_review', 'rejected'].includes(phase)) {
		throw new Error("External ledger phase is invalid.");
	}
	// Re-recording the validating phase is legal: it merges late-arriving
	// validation artifacts (for example the CI run reference) idempotently.
	if (phase === "validating" && item.phase !== "candidate" && item.phase !== "validating") throw new Error("Only a candidate can enter validation.");
	if (phase === "promoting" && item.phase !== "validating") throw new Error("Only a validated candidate can enter promotion.");
	// A deployed record straight from validating is legal when promotion
	// evidence exists: either the observed run reference or the durable
	// dispatch key of the applied promote command.
	if (phase === "deployed" && item.phase !== "promoting" && !(item.phase === "validating" && (artifacts.promotion ?? item.artifacts.promotion))) {
		throw new Error("Recording deployed requires phase promoting, or promotion evidence in artifacts.promotion.");
	}
	if (phase === "completed" && item.phase !== "deployed") throw new Error("Only a deployed candidate can complete.");
	if (phase === "promoting" && typeof (artifacts.validation?.url ?? item.artifacts.validation?.url) !== "string") {
		throw new Error("Promotion requires a validation artifact.");
	}
	if (phase === "deployed" && typeof (artifacts.deploymentUrl ?? item.artifacts.deploymentUrl) !== "string") {
		throw new Error("A deployed work item requires a deployment artifact.");
	}
	if (phase === "completed" && typeof (artifacts.deploymentUrl ?? item.artifacts.deploymentUrl) !== "string") {
		throw new Error("A completed work item requires a deployment artifact.");
	}
	return next(item, phase, at, {
		artifacts: { ...item.artifacts, ...artifacts },
		activeImplementation: phase === "retryable" ? null : item.activeImplementation,
	});
}
