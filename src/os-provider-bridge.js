const REPOSITORY = "callil/autonomous-live-chat";
const RUNNER_URL = "https://app-harness-os-native-git.coda-a.workers.dev";
const ORCHESTRATOR_URL = "https://app-harness-os-orchestrator.coda-a.workers.dev";

const WORK_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const ISSUE_URL = new RegExp(`^https://github\\.com/${REPOSITORY}/issues/(\\d+)$`, "i");

function safeWorkItemId(value) {
	if (typeof value !== "string" || !WORK_ITEM_ID.test(value)) throw new Error("OS work needs a bounded durable work-item ID.");
	return value;
}

function issueNumber(issueUrl) {
	if (typeof issueUrl !== "string") throw new Error("OS work needs the linked issue for the allowlisted repository.");
	const match = issueUrl.match(ISSUE_URL);
	if (!match) throw new Error("OS work needs the linked issue for the allowlisted repository.");
	return Number(match[1]);
}

function safeRoom(value) {
	if (typeof value !== "string" || !WORK_ITEM_ID.test(value)) throw new Error("OS work needs a bounded room ID.");
	return value;
}

function safeGeneration(value) {
	if (!Number.isInteger(value) || value < 1) throw new Error("OS work generation is invalid.");
	return value;
}

/**
 * The planning service receives a bounded work manifest, not a repository
 * credential or shell surface. The original request is deliberately omitted
 * from the later runner job.
 */
export function createOsPlanningManifest({ workItemId, issueUrl, request, target, room = "main", generation = 1 }) {
	const id = safeWorkItemId(workItemId);
	const issue = issueNumber(issueUrl);
	const safeRoomName = safeRoom(room);
	const safeGenerationNumber = safeGeneration(generation);
	if (typeof request !== "string" || !request.trim() || request.length > 500) throw new Error("OS planning needs a bounded request.");
	return {
		workItemId: id,
		issueUrl,
		repository: REPOSITORY,
		request: request.trim(),
		...(target?.targetId && target?.page ? { target: { targetId: target.targetId, page: target.page, ...(target.label ? { label: target.label } : {}) } } : {}),
		stack: { id: `stack-${id}`, lane: `room-${safeRoomName}`, generation: safeGenerationNumber },
		runnerUrl: RUNNER_URL,
		orchestratorUrl: ORCHESTRATOR_URL,
		issueNumber: issue,
	};
}

/**
 * Convert a model-approved, schema-validated plan into a runner job. No
 * original prose, prompt, source, or model response crosses this boundary.
 */
export function createOsNativeGitJob({ manifest, plan }) {
	if (!manifest || manifest.repository !== REPOSITORY || !Number.isInteger(manifest.issueNumber)) throw new Error("OS runner job needs a valid planning manifest.");
	if (!plan || plan.kind !== "accent-color" || !["blue", "green", "purple", "orange"].includes(plan.color)) throw new Error("OS runner job needs an allowlisted model plan.");
	const workItemId = safeWorkItemId(manifest.workItemId);
	const generation = safeGeneration(manifest.stack?.generation);
	return {
		jobId: `os-${workItemId}-g${generation}`,
		repository: REPOSITORY,
		generation,
		candidate: {
			change: { kind: "accent-color", color: plan.color },
			stack: {
				stackId: manifest.stack.id,
				nodeId: "root",
				branch: `app-harness-os/${manifest.issueNumber}/g${generation}`,
				parentBranch: "main",
				parentBaseSha: null,
				pullRequestBase: "main",
				issueNumber: manifest.issueNumber,
			},
		},
	};
}

/** Map only actual runner responses into truthful Durable Object states. */
export function classifyOsRunnerResponse(value) {
	const state = value && typeof value === "object" ? value.state : undefined;
	const classification = value && typeof value === "object" && typeof value.classification === "string" && /^[a-z0-9-]{1,80}$/u.test(value.classification) ? value.classification : null;
	if (state === "checked-out") return { phase: "building", detail: "Cloudflare OS isolated workspace checked out the allowed repository.", terminal: false };
	if (state === "pull-request-opened") return { phase: "building", detail: "Cloudflare OS native Git candidate branch was pushed and its pull request was opened.", terminal: false };
	if (state === "needs-restack") return { phase: "needs_review", detail: "Cloudflare OS detected a changed parent base and marked the stack for a single root-led restack.", terminal: true };
	if (state === "credential-bridge-required") return { phase: "needs_review", detail: "Cloudflare OS runner is reachable, but native Git is blocked until the repository credential bridge is enabled.", terminal: true };
	if (state === "checkout-failed" || state === "candidate-failed") return { phase: "needs_review", detail: `Cloudflare OS native candidate execution failed${classification ? ` (${classification})` : ""}. No deployment was created.`, terminal: true };
	return { phase: "needs_review", detail: "Cloudflare OS runner returned an unrecognized status. No native Git action is claimed.", terminal: true };
}

export { REPOSITORY as OS_NATIVE_GIT_REPOSITORY, RUNNER_URL as OS_NATIVE_GIT_RUNNER_URL, ORCHESTRATOR_URL as OS_AGENT_ORCHESTRATOR_URL };
