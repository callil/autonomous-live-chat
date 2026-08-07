/**
 * Model-facing vocabulary for the pure-Workers operator. Every command is a
 * strict JSON-Schema tool, so an invented method or malformed argument shape
 * is unrepresentable instead of prompt-managed. The loop, never the model,
 * supplies workItemId, expectedVersion, leaseId, and every minted identifier.
 */

const CI_PROFILES = ["visual", "content", "behavior", "data", "infrastructure"];
const EXTERNAL_PHASES = ["validating", "promoting", "deployed", "completed", "retryable", "needs_review", "rejected"];
const EVENT_SOURCES = ["cloudflare-os", "github", "runner", "ci", "system"];
const ISSUE_CLASSIFICATIONS = ["triage", "agent", "needs-review", "rejected", "deployed"];

export const OPERATOR_LEASE_MS = 900_000;

export const SYSTEM_PROMPT =
	"You operate the App Harness ledger for one work item. State (the user message) is authoritative; do not re-read. "
	+ "Progress steps in order: claim -> classification -> issue -> plan -> implementation -> candidate -> validating -> promotion -> deployed -> completed. "
	+ "If State.leaseId is null, stageClaim first. One tool per step; keep advancing while the ledger accepts. On rejected, the error says why: correct once or stop. "
	+ "Results arrive by push, so never poll getCandidate or re-stage implementation while implementing: when State.facts.runnerResult reports pull-request-opened, stageCandidate from it; on a failure fact or implementationProblem, stageImplementation again or replan; if waiting, stageDefer 60000. "
	+ "In validating, observeCandidateValidation; on success stageState validating with its artifacts, then stagePromotion with a fresh dispatchKey. "
	+ "On validation or promotion failure, restack: stagePlan with the next generation and a fresh getMainSha baseSha. "
	+ "When the promotion run succeeds (findPromotionRun/inspectPromotionRun), stageState deployed, then completed. "
	+ "stageRelease and stageDefer are parking exits: after either, stop. Reply exactly PROGRESSED, PARKED:<code>, or COMPLETE.";

function tool(name, description, properties) {
	return {
		type: "function",
		function: {
			name,
			description,
			strict: true,
			parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
		},
	};
}

export const TOOLS = [
	tool("getMainSha", "Read the current immutable main revision.", {}),
	tool("getCandidate", "Read an existing candidate pull request without changing it. Fallback only: the candidate normally arrives by push in State.facts.runnerResult.", {
		branch: { type: "string" },
		pullRequestBase: { type: "string" },
	}),
	tool("observeCandidateValidation", "Read the trusted candidate CI run bound to an exact pull request and immutable head revision.", {
		pullRequest: { type: "integer" },
		headSha: { type: "string" },
	}),
	tool("findPromotionRun", "Read the deterministic GitHub Actions promotion run for a dispatch key.", {
		dispatchKey: { type: "string" },
		createdAfter: { type: ["string", "null"] },
	}),
	tool("inspectPromotionRun", "Read the status of a GitHub Actions promotion run.", {
		runId: { type: "integer" },
	}),
	tool("inspectImplementation", "Read the current result of the isolated implementation run. The run identifier is supplied by the loop.", {
		generation: { type: "integer" },
	}),
	tool("stageClaim", "Claim this work item. The loop mints the lease; there is nothing to supply.", {}),
	tool("stageRelease", "Release the work-item lease and end this turn.", {}),
	tool("stageClassification", "Record the durable classification for claimed work.", {
		decision: { type: "string", enum: ["eligible", "needs_review", "rejected"] },
		changeType: { type: "string", enum: CI_PROFILES },
		scope: { type: "string", enum: ["localized", "bounded", "broad"] },
		risk: { type: "string", enum: ["low", "medium", "high"] },
		affectedSurface: { type: "string", enum: ["ui", "copy", "data", "behavior", "infrastructure"] },
		reversible: { type: "boolean" },
		executionEligibility: { type: "string", enum: ["eligible", "needs_review"] },
		ciProfile: { type: "string", enum: CI_PROFILES },
		message: { type: "string" },
	}),
	tool("stagePlan", "Record the one-node stack plan. The ledger derives revision, branch, and stack identity from its own durable facts.", {
		baseSha: { type: "string", description: "The exact sha returned by getMainSha." },
		generation: { type: "integer" },
		summary: { type: "string" },
		ciProfile: { type: "string", enum: CI_PROFILES },
		message: { type: "string" },
	}),
	tool("stageIssue", "Create the public GitHub issue for eligible classified work.", {
		title: { type: "string" },
		body: { type: "string" },
		classification: { type: "string", enum: ISSUE_CLASSIFICATIONS },
	}),
	tool("stageImplementation", "Start one isolated implementation run for the accepted plan. The loop mints the run identifier.", {}),
	tool("stageCandidate", "Record the candidate pull request opened by the active implementation run.", {
		headSha: { type: "string" },
		pullRequestNumber: { type: "integer" },
		pullRequestUrl: { type: "string" },
		message: { type: "string" },
	}),
	tool("stagePromotion", "Dispatch the trusted promotion workflow for the validated candidate.", {
		pullRequestNumber: { type: "integer" },
		headSha: { type: "string" },
		dispatchKey: { type: "string", description: "Fresh unique identifier for this promotion dispatch." },
	}),
	tool("stageState", "Record an externally observed phase transition with its evidence.", {
		phase: { type: "string", enum: EXTERNAL_PHASES },
		artifacts: {
			type: ["object", "null"],
			description: "External evidence to merge; null when the phase carries none.",
			properties: {
				validation: {
					type: ["object", "null"],
					properties: { url: { type: "string" }, runId: { type: "integer" }, conclusion: { type: "string" } },
					required: ["url", "runId", "conclusion"],
					additionalProperties: false,
				},
				promotion: {
					type: ["object", "null"],
					properties: { url: { type: "string" }, runId: { type: "integer" } },
					required: ["url", "runId"],
					additionalProperties: false,
				},
			},
			required: ["validation", "promotion"],
			additionalProperties: false,
		},
		message: { type: "string" },
		source: { type: "string", enum: EVENT_SOURCES },
	}),
	tool("stageDefer", "Park this work item for a bounded delay and end this turn.", {
		delayMs: { type: "integer" },
		message: { type: "string" },
	}),
];

export const OBSERVATION_TOOLS = new Set(["getMainSha", "getCandidate", "observeCandidateValidation", "findPromotionRun", "inspectPromotionRun", "inspectImplementation"]);
export const STAGE_TOOLS = new Set([...TOOLS.map((entry) => entry.function.name)].filter((name) => !OBSERVATION_TOOLS.has(name)));
export const PARKING_TOOLS = new Set(["stageRelease", "stageDefer"]);

function stageArtifacts(value) {
	if (!value || typeof value !== "object") return {};
	const artifacts = {};
	if (value.validation) artifacts.validation = value.validation;
	if (value.promotion) artifacts.promotion = value.promotion;
	return Object.keys(artifacts).length ? { artifacts } : {};
}

/**
 * Build the exact ledger OperatorCommand for a stage tool call. The context
 * carries only loop-owned facts: the current lease, the snapshot's active run
 * and plan identity, and one high-entropy minted identifier per call, so a
 * crash-resumed replay stages the identical command.
 */
export function commandFor(name, args, ctx) {
	const leaseId = typeof ctx.leaseId === "string" && ctx.leaseId ? ctx.leaseId : "";
	switch (name) {
		case "stageClaim": return { kind: "claim", leaseId: ctx.minted, leaseMs: OPERATOR_LEASE_MS };
		case "stageRelease": return { kind: "release", leaseId };
		case "stageClassification": return {
			kind: "classify",
			leaseId,
			classification: {
				decision: args.decision,
				changeType: args.changeType,
				scope: args.scope,
				risk: args.risk,
				affectedSurface: args.affectedSurface,
				reversible: args.reversible,
				executionEligibility: args.executionEligibility,
				ciProfile: args.ciProfile,
			},
			message: args.message,
		};
		// Placeholder stack fields are overwritten by the ledger's canonical
		// one-node plan derivation; only the model's real decisions pass through.
		case "stagePlan": return {
			kind: "plan",
			leaseId,
			plan: {
				revision: 1,
				baseSha: args.baseSha,
				stackId: "",
				generation: args.generation,
				nodeId: "root",
				branch: "pending",
				parentBranch: "main",
				parentBaseSha: args.baseSha,
				pullRequestBase: "main",
				issueNumber: ctx.issueNumber,
				summary: args.summary,
				ciProfile: args.ciProfile,
			},
			message: args.message,
		};
		case "stageIssue": return { kind: "create-issue", leaseId, title: args.title, body: args.body, classification: args.classification };
		case "stageImplementation": return { kind: "implement", leaseId, runId: ctx.minted };
		case "stageCandidate": return { kind: "record-candidate", leaseId, runId: ctx.activeRunId, branch: ctx.planBranch, headSha: args.headSha, pullRequestNumber: args.pullRequestNumber, pullRequestUrl: args.pullRequestUrl, message: args.message };
		case "stagePromotion": return { kind: "promote", leaseId, pullRequestNumber: args.pullRequestNumber, headSha: args.headSha, dispatchKey: args.dispatchKey };
		case "stageState": return { kind: "record-state", leaseId, phase: args.phase, ...stageArtifacts(args.artifacts), message: args.message, source: args.source };
		case "stageDefer": return { kind: "defer", leaseId, delayMs: args.delayMs, message: args.message };
		default: throw new Error(`Unknown operator stage tool '${name}'.`);
	}
}
