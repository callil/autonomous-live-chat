/**
 * Model-facing vocabulary for the pure-Workers operator. Every command is a
 * strict JSON-Schema tool, so an invented method or malformed argument shape
 * is unrepresentable instead of prompt-managed. The loop, never the model,
 * supplies workItemId, expectedVersion, and every minted identifier.
 */

const CI_PROFILES = ["visual", "content", "behavior", "data", "infrastructure"];
const EXTERNAL_PHASES = ["validating", "promoting", "deployed", "completed", "retryable", "needs_review", "rejected"];
const EVENT_SOURCES = ["cloudflare-os", "github", "runner", "ci", "system"];
const ISSUE_CLASSIFICATIONS = ["triage", "agent", "needs-review", "rejected", "deployed"];

export const SYSTEM_PROMPT =
	"You operate the App Harness ledger for one work item. State is authoritative. "
	+ "Order: classification -> issue -> plan -> implementation -> candidate -> validating -> promotion -> deployed -> completed. "
	+ "One tool per step; advance while the ledger accepts; on rejected, correct once or stop. "
	+ "Results arrive by push: never poll getCandidate. stageCandidate from a pull-request-opened State.facts.runnerResult; on failure or implementationProblem, stageImplementation again or replan. "
	+ "Stage from pushed State.facts. On validation success stageState validating, then WAIT: candidates auto-merge and deploy on their own. When facts.merged and a success facts.mainDeploy arrive, stageState deployed with both as artifacts, then completed. "
	+ "stagePromotion is the fallback if no merged fact arrives after a long wait. "
	+ "On validation or promotion failure, or phase retryable (the failed run was already cleared), restack: stagePlan with the next generation and a fresh getMainSha baseSha; never wait for a cleared run. "
	+ "Observe only when the phase needs an answer and no fact is present. "
	+ "Reply WAITING when only an external result can advance; reply exactly PROGRESSED, WAITING, PARKED:<code>, or COMPLETE.";

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
	tool("observeCandidateValidation", "Read the trusted candidate CI run bound to an exact pull request and immutable head revision. Fallback only: the result normally arrives by push in State.facts.validation.", {
		pullRequest: { type: "integer" },
		headSha: { type: "string" },
	}),
	tool("findPromotionRun", "Read the deterministic GitHub Actions promotion run for a dispatch key. Fallback only: the result normally arrives by push in State.facts.promotion.", {
		dispatchKey: { type: "string" },
		createdAfter: { type: ["string", "null"] },
	}),
	tool("inspectPromotionRun", "Read the status of a GitHub Actions promotion run.", {
		runId: { type: "integer" },
	}),
	tool("inspectImplementation", "Read the current result of the isolated implementation run. The run identifier is supplied by the loop.", {
		generation: { type: "integer" },
	}),
	tool("stageClassification", "Record the durable classification for submitted work.", {
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
	tool("stagePromotion", "Fallback merge path: dispatch the trusted promotion workflow for a validated candidate that auto-merge did not land. The candidate identity and dispatch key are supplied by the loop.", {}),
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
				merged: {
					type: ["object", "null"],
					properties: { number: { type: "integer" }, url: { type: "string" }, headSha: { type: "string" }, mergeCommitSha: { type: "string" }, branch: { type: "string" } },
					required: ["number", "url", "headSha", "mergeCommitSha", "branch"],
					additionalProperties: false,
				},
				mainDeploy: {
					type: ["object", "null"],
					properties: { url: { type: "string" }, runId: { type: "integer" }, conclusion: { type: "string" } },
					required: ["url", "runId", "conclusion"],
					additionalProperties: false,
				},
			},
			required: ["validation", "promotion", "merged", "mainDeploy"],
			additionalProperties: false,
		},
		message: { type: "string" },
		source: { type: "string", enum: EVENT_SOURCES },
	}),
];

export const OBSERVATION_TOOLS = new Set(["getMainSha", "getCandidate", "observeCandidateValidation", "findPromotionRun", "inspectPromotionRun", "inspectImplementation"]);
export const STAGE_TOOLS = new Set([...TOOLS.map((entry) => entry.function.name)].filter((name) => !OBSERVATION_TOOLS.has(name)));

function stageArtifacts(value) {
	if (!value || typeof value !== "object") return {};
	const artifacts = {};
	if (value.validation) artifacts.validation = value.validation;
	if (value.promotion) artifacts.promotion = value.promotion;
	if (value.merged) artifacts.merged = value.merged;
	if (value.mainDeploy) artifacts.mainDeploy = value.mainDeploy;
	return Object.keys(artifacts).length ? { artifacts } : {};
}

/**
 * Build the exact ledger OperatorCommand for a stage tool call. The context
 * carries only loop-owned facts: the snapshot's active run and plan identity,
 * and one high-entropy minted identifier per call, so a crash-resumed replay
 * stages the identical command.
 */
export function commandFor(name, args, ctx) {
	switch (name) {
		case "stageClassification": return {
			kind: "classify",
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
		case "stageIssue": return { kind: "create-issue", title: args.title, body: args.body, classification: args.classification };
		case "stageImplementation": return { kind: "implement", runId: ctx.minted };
		case "stageCandidate": return { kind: "record-candidate", runId: ctx.activeRunId, branch: ctx.planBranch, headSha: args.headSha, pullRequestNumber: args.pullRequestNumber, pullRequestUrl: args.pullRequestUrl, message: args.message };
		case "stagePromotion": {
			// Candidate identity is the ledger's fact and the dispatch key is a
			// minted nonce - mechanical values the model must never retype.
			if (!ctx.candidatePr || !ctx.candidateHeadSha) throw new Error("No validated candidate is recorded for promotion yet.");
			return { kind: "promote", pullRequestNumber: ctx.candidatePr, headSha: ctx.candidateHeadSha, dispatchKey: ctx.minted };
		}
		case "stageState": return { kind: "record-state", phase: args.phase, ...stageArtifacts(args.artifacts), message: args.message, source: args.source };
		default: throw new Error(`Unknown operator stage tool '${name}'.`);
	}
}
