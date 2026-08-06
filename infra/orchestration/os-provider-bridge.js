const REPOSITORY = "callil/autonomous-live-chat";
const RUNNER_URL = "https://app-harness-os-native-git.coda-a.workers.dev";
const GADGET_KEY = REPOSITORY;
const CHAT_KEY = "repository-main";

const WORK_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA = /^[0-9a-f]{40}$/iu;
const ISSUE_URL = new RegExp(`^https://github\\.com/${REPOSITORY}/issues/(\\d+)$`, "i");

function safeWorkItemId(value) {
	if (typeof value !== "string" || !WORK_ITEM_ID.test(value)) throw new Error("OS work needs a durable UUID work-item ID.");
	return value;
}

function safeIssue(issue) {
	if (!issue || !Number.isInteger(issue.number) || issue.number < 1 || typeof issue.url !== "string") {
		throw new Error("OS work needs its durable GitHub issue.");
	}
	const match = issue.url.match(ISSUE_URL);
	if (!match || Number(match[1]) !== issue.number) throw new Error("OS issue authority does not match the repository.");
	return { number: issue.number, url: issue.url };
}

function safeRequest(value) {
	if (typeof value !== "string" || !value.trim()) throw new Error("OS work needs a durable request.");
	return value.trim();
}

function safeGeneration(value) {
	if (!Number.isInteger(value) || value < 1) throw new Error("OS work generation is invalid.");
	return value;
}

/**
 * Build one idempotent message for the persistent repository workspace. The
 * message may guide the agent, but it grants no repository authority: the
 * capability bridge accepts only the durable work-item and issue identifiers.
 */
export function createOsWorkspaceSubmission({ workItemId, issue, request, target, responseTarget }) {
	const id = safeWorkItemId(workItemId);
	const linkedIssue = safeIssue(issue);
	const durableRequest = safeRequest(request);
	if (!responseTarget) throw new Error("OS workspace submission needs a persistent response target.");
	const targetLine = target?.targetId && target?.page
		? `Target context: ${String(target.targetId).slice(0, 64)} on ${String(target.page).slice(0, 160)}.`
		: "No element target was supplied.";
	return {
		gadgetKey: GADGET_KEY,
		chatKey: CHAT_KEY,
		messageKey: id,
		gadgetTitle: "App Harness · autonomous-live-chat",
		prompt: [
			`A public App Harness request is ready in ${REPOSITORY}, issue #${linkedIssue.number}, work item ${id}.`,
			`Request: ${durableRequest}`,
			targetLine,
			"Use the repository context and your safety guidelines to assess the request.",
			`When you are ready to start implementation, call APP_HARNESS.enqueueRepositoryTask with exactly {\"workItemId\":\"${id}\",\"issueNumber\":${linkedIssue.number}}.`,
			"The capability resolves the repository and original request from durable state; do not add repository names, source text, shell commands, or credentials to that call.",
			"Report your concise decision and current status publicly when the turn ends.",
		].join("\n"),
		chatGatewayRpcTarget: responseTarget,
	};
}

/** Validate a typed OS capability request against durable, server-owned state. */
export function validateOsExecutionRequest(input, durable) {
	const id = safeWorkItemId(input?.workItemId);
	const issue = safeIssue(durable?.issue);
	if (id !== durable?.workItemId || input?.issueNumber !== issue.number) {
		throw new Error("Cloudflare OS execution request does not match its durable issue.");
	}
	return { workItemId: id, issueNumber: issue.number };
}

/**
 * Idempotency is owned by the durable outbox, not by agent output. Once the
 * fixed observe-main effect exists (or the job is later in the pipeline), a
 * repeated capability call is an acknowledgement only.
 */
export function osExecutionDisposition({ terminal, existingEffect, jobStage }) {
	if (terminal) return "terminal";
	if (existingEffect || ["running", "awaiting-callback"].includes(jobStage)) return "duplicate";
	return "queue";
}

/** OS actions may remain pending after the agent turn while a user approves them. */
export function osWorkspaceTurnDisposition(jobStage) {
	return jobStage === "awaiting-os" ? "awaiting-action" : "delegated";
}

/** Create the runner job exclusively from original durable request data. */
export function createOsNativeGitJob({ workItemId, issue, request, generation = 1, parentBaseSha = null }) {
	const id = safeWorkItemId(workItemId);
	const linkedIssue = safeIssue(issue);
	const durableRequest = safeRequest(request);
	const safeGenerationNumber = safeGeneration(generation);
	if (parentBaseSha !== null && (typeof parentBaseSha !== "string" || !SHA.test(parentBaseSha))) throw new Error("OS runner job parent base must be a full Git SHA.");
	return {
		jobId: `os-${id}-g${safeGenerationNumber}`,
		repository: REPOSITORY,
		generation: safeGenerationNumber,
		candidate: {
			change: { kind: "repository-task", request: durableRequest },
			stack: {
				stackId: `stack-${id}`,
				nodeId: "root",
				branch: `app-harness-os/${linkedIssue.number}/g${safeGenerationNumber}`,
				parentBranch: "main",
				parentBaseSha: parentBaseSha?.toLowerCase() ?? null,
				pullRequestBase: "main",
				issueNumber: linkedIssue.number,
			},
		},
	};
}

/** Keep stack topology metadata bounded; the full request remains in durable work state. */
export function createStackNodeIntent(issue) {
	const linkedIssue = safeIssue(issue);
	return `Implement App Harness issue #${linkedIssue.number} from its durable work record.`;
}

/** Map only actual runner responses into truthful Durable Object states. */
export function classifyOsRunnerResponse(value) {
	const state = value && typeof value === "object" ? value.state : undefined;
	const classification = value && typeof value === "object" && typeof value.classification === "string" && /^[a-z0-9-]{1,80}$/u.test(value.classification) ? value.classification : null;
	if (state === "runner-unavailable" && classification === "sandbox-runtime-interrupted") {
		return { phase: "building", detail: "Cloudflare restarted the isolated Sandbox during execution; a fresh durable attempt is required.", terminal: false, retryable: true };
	}
	if (state === "checked-out") return { phase: "building", detail: "Cloudflare OS isolated workspace checked out the allowed repository.", terminal: false, retryable: false };
	if (state === "pull-request-opened") return { phase: "building", detail: "Cloudflare OS native Git candidate branch was pushed and its pull request was opened.", terminal: false, retryable: false };
	if (state === "needs-restack") return { phase: "building", detail: "Cloudflare OS detected a changed parent base; the coordinator must advance the root stack generation.", terminal: false, retryable: false };
	if (state === "credential-bridge-required") return { phase: "needs_review", detail: "Cloudflare OS runner is reachable, but native Git is blocked until the repository credential bridge is enabled.", terminal: true, retryable: false };
	if (state === "checkout-failed" || state === "candidate-failed") return { phase: "needs_review", detail: `Cloudflare OS native candidate execution failed${classification ? ` (${classification})` : ""}. No deployment was created.`, terminal: true, retryable: false };
	return { phase: "needs_review", detail: "Cloudflare OS runner returned an unrecognized status. No native Git action is claimed.", terminal: true, retryable: false };
}

export { REPOSITORY as OS_NATIVE_GIT_REPOSITORY, RUNNER_URL as OS_NATIVE_GIT_RUNNER_URL };
