import { applyStackEvent, promotionKey, validateStackLedger } from "./stack-ledger.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u;
const TERMINAL_PHASES = new Set(["completed", "requires_review", "rejected", "failed"]);
const EFFECT_STATES = new Set(["pending", "leased", "delivered", "failed"]);
const AGENT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u;

function id(value, label) {
	if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a bounded identifier.`);
	return value;
}

function timestamp(value, label) {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative timestamp.`);
	return value;
}

export function isTerminalCoordinatorJob(job) {
	return Boolean(job && job.stage === "terminal");
}

/** Keep only bounded audit identifiers. Prompts, tool output, diffs, and file contents are intentionally discarded. */
export function normalizeAgentProvenance(value) {
	if (!value || typeof value !== "object") return undefined;
	const model = typeof value.model === "string" && AGENT_VALUE.test(value.model) ? value.model : null;
	if (!model) return undefined;
	const bounded = (input, limit) => Array.isArray(input)
		? [...new Set(input.filter((entry) => typeof entry === "string" && AGENT_VALUE.test(entry)))].slice(0, limit)
		: [];
	return { model, responseIds: bounded(value.responseIds, 8), tools: bounded(value.tools, 24) };
}

export function createCoordinatorJob({ workflowId, workItemId, pipeline, firstEffectId, now }) {
	if (pipeline !== "os-native-git") throw new Error("Coordinator pipeline is invalid.");
	return {
		schemaVersion: 1,
		id: id(workflowId, "Workflow ID"),
		workItemId: id(workItemId, "Work item ID"),
		pipeline,
		stage: "queued",
		currentEffectId: id(firstEffectId, "Effect ID"),
		lease: null,
		callbackKeys: [],
		createdAt: timestamp(now, "Creation time"),
		updatedAt: timestamp(now, "Update time"),
	};
}

export function createCoordinatorEffect({ id: effectId, jobId, workItemId, kind, payload = {}, now, blocking = true }) {
	if (typeof kind !== "string" || !kind) throw new Error("Effect kind is required.");
	return {
		schemaVersion: 1,
		id: id(effectId, "Effect ID"),
		jobId: id(jobId, "Job ID"),
		workItemId: id(workItemId, "Work item ID"),
		kind,
		payload,
		blocking,
		state: "pending",
		attempts: 0,
		availableAt: timestamp(now, "Effect availability"),
		leaseToken: null,
		leaseExpiresAt: null,
		createdAt: timestamp(now, "Creation time"),
		updatedAt: timestamp(now, "Update time"),
	};
}

export function claimCoordinatorEffect(job, effect, { now, leaseToken, leaseMs }) {
	if (!job || job.schemaVersion !== 1 || !effect || effect.schemaVersion !== 1 || effect.jobId !== job.id) throw new Error("Coordinator claim records do not match.");
	if (!EFFECT_STATES.has(effect.state)) throw new Error("Coordinator effect state is invalid.");
	if (effect.state === "delivered" || effect.state === "failed") return { disposition: "settled", job, effect };
	if (isTerminalCoordinatorJob(job) && effect.blocking) return { disposition: "terminal", job, effect };
	if (effect.blocking && job.currentEffectId !== effect.id) return { disposition: "stale", job, effect };
	const at = timestamp(now, "Claim time");
	if (effect.availableAt > at) return { disposition: "not-due", job, effect };
	if (job.lease && job.lease.effectId !== effect.id && job.lease.expiresAt > at) return { disposition: "busy", job, effect };
	if (effect.state === "leased" && effect.leaseExpiresAt !== null && effect.leaseExpiresAt > at) return { disposition: "busy", job, effect };
	if (!Number.isFinite(leaseMs) || leaseMs < 1) throw new Error("Lease duration must be positive.");
	const token = id(leaseToken, "Lease token");
	const expiresAt = at + leaseMs;
	return {
		disposition: "claimed",
		job: { ...job, lease: { effectId: effect.id, token, expiresAt }, updatedAt: at },
		effect: { ...effect, state: "leased", attempts: effect.attempts + 1, leaseToken: token, leaseExpiresAt: expiresAt, updatedAt: at },
	};
}

/** @param {any} job @param {any} effect @param {{ leaseToken: string, now: number, nextEffectId?: string | null, nextStage?: string }} options */
export function completeCoordinatorEffect(job, effect, { leaseToken, now, nextEffectId = null, nextStage = job.stage }) {
	const at = timestamp(now, "Completion time");
	if (effect.state === "delivered") return { disposition: "duplicate", job, effect };
	if (effect.state !== "leased" || effect.leaseToken !== leaseToken || job.lease?.token !== leaseToken || job.lease.effectId !== effect.id) {
		return { disposition: "stale", job, effect };
	}
	const nextId = nextEffectId === null ? null : id(nextEffectId, "Next effect ID");
	return {
		disposition: "completed",
		job: { ...job, stage: nextStage, currentEffectId: effect.blocking ? nextId : job.currentEffectId, lease: null, updatedAt: at },
		effect: { ...effect, state: "delivered", leaseToken: null, leaseExpiresAt: null, updatedAt: at },
	};
}

export function retryCoordinatorEffect(job, effect, { leaseToken, now, availableAt, terminal = false }) {
	const at = timestamp(now, "Retry time");
	if (effect.state !== "leased" || effect.leaseToken !== leaseToken || job.lease?.token !== leaseToken || job.lease.effectId !== effect.id) {
		return { disposition: "stale", job, effect };
	}
	const nextTime = timestamp(availableAt, "Retry availability");
	return {
		disposition: terminal ? "failed" : "retrying",
		job: terminal
			? effect.blocking
				? { ...job, stage: "terminal", terminalPhase: "failed", currentEffectId: null, lease: null, updatedAt: at }
				: { ...job, lease: null, updatedAt: at }
			: effect.blocking ? { ...job, stage: "queued", lease: null, updatedAt: at } : { ...job, lease: null, updatedAt: at },
		effect: { ...effect, state: terminal ? "failed" : "pending", availableAt: nextTime, leaseToken: null, leaseExpiresAt: null, updatedAt: at },
	};
}

export function applyCoordinatorCallback(job, { callbackKey, phase, now }) {
	const key = id(callbackKey, "Callback key");
	const at = timestamp(now, "Callback time");
	if (job.callbackKeys.includes(key)) return { disposition: "duplicate", job };
	if (isTerminalCoordinatorJob(job)) return { disposition: "stale", job };
	const terminal = TERMINAL_PHASES.has(phase);
	return {
		disposition: "applied",
		job: {
			...job,
			stage: terminal ? "terminal" : "awaiting-callback",
			terminalPhase: terminal ? phase : undefined,
			currentEffectId: terminal ? null : job.currentEffectId,
			lease: null,
			callbackKeys: [...job.callbackKeys, key].slice(-100),
			updatedAt: at,
		},
	};
}

function applyLedgerEvent(ledger, event, allowedStaleReasons = []) {
	const outcome = applyStackEvent(ledger, event);
	if (outcome.disposition === "applied" || outcome.disposition === "duplicate") return outcome.ledger;
	if (allowedStaleReasons.includes(outcome.reason)) return outcome.ledger;
	throw new Error(`Stack reconciliation rejected ${event.type} (${outcome.reason}).`);
}

export function reconcileCompletedStack(ledger, { currentMainSha, headSha, mergeSha, deploymentUrl, runId }) {
	validateStackLedger(ledger);
	if (ledger.status === "completed") return ledger;
	const generation = ledger.generation;
	let next = ledger;
	if (currentMainSha !== next.currentBaseSha) {
		next = applyLedgerEvent(next, { type: "main-observed", eventId: `callback-main-g${generation}`, generation, mainSha: currentMainSha });
	}
	const node = next.nodes.find((candidate) => candidate.state !== "merged");
	if (!node || node.headSha !== headSha) throw new Error("Completion callback does not match the current stack head.");
	next = applyLedgerEvent(next, { type: "node-validation-recorded", eventId: `callback-validation-g${generation}`, generation, nodeId: node.id, headSha, outcome: "passed" });
	const dispatchKey = promotionKey(next.id, generation, node.id, headSha, next.currentBaseSha);
	next = applyLedgerEvent(next, { type: "promotion-planned", eventId: `callback-promotion-plan-g${generation}`, generation, nodeId: node.id, dispatchKey });
	next = applyLedgerEvent(next, { type: "promotion-dispatched", eventId: `callback-promotion-dispatch-g${generation}`, generation, dispatchKey, runId: String(runId) });
	next = applyLedgerEvent(next, { type: "promotion-validated", eventId: `callback-promotion-valid-g${generation}`, generation, dispatchKey, headSha, baseSha: next.currentBaseSha });
	next = applyLedgerEvent(next, { type: "promotion-merge-started", eventId: `callback-merge-start-g${generation}`, generation, dispatchKey, currentMainSha: next.currentBaseSha, headSha });
	next = applyLedgerEvent(next, { type: "promotion-merged", eventId: `callback-merged-g${generation}`, generation, dispatchKey, headSha, mergeSha });
	next = applyLedgerEvent(next, { type: "deployment-attempt-started", eventId: `callback-deploy-start-g${generation}`, generation, attemptToken: `callback-deploy-g${generation}`, mergeSha });
	next = applyLedgerEvent(next, { type: "deployment-succeeded", eventId: `callback-deployed-g${generation}`, generation, attemptToken: `callback-deploy-g${generation}`, deploymentUrl });
	return next;
}

export function blockCoordinatorStack(ledger) {
	validateStackLedger(ledger);
	if (["blocked", "cancelled", "completed"].includes(ledger.status)) return ledger;
	return applyLedgerEvent(ledger, {
		type: "coordinator-blocked",
		eventId: `coordinator-blocked-g${ledger.generation}`,
		generation: ledger.generation,
	});
}
