import { restackPlan, stackConcurrencyGroup, stackConcurrencyKey, validateStack } from "./stack-scheduler.js";

/**
 * Credential-free preparation for the future Cloudflare OS native-Git runner.
 *
 * It is intentionally a planner, not an executor: it cannot fetch, clone,
 * call a model, launch a Sandbox, mint a token, or contact GitHub. The future
 * Worker may consume the returned plan only after a separately approved
 * repository capability and credential broker are deployed.
 */

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const AUDIT_KINDS = new Set([
	"job-prepared",
	"repository-capability-requested",
	"sandbox-created",
	"checkout-started",
	"checkout-finished",
	"command-started",
	"command-finished",
	"branch-updated",
	"pull-request-updated",
	"ci-reported",
	"deployment-reported",
	"job-blocked",
]);

/** @param {string} value @param {string} label */
function requireSafeId(value, label) {
	if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
		throw new Error(`${label} must be a bounded identifier.`);
	}
	return value;
}

/** @param {string} repository */
export function validateRepositoryCapability(repository) {
	if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)) {
		throw new Error("Repository capability must be an owner/repository name.");
	}
	return repository.toLowerCase();
}

/**
 * The only credential shape the eventual runner is allowed to request. It is
 * metadata, never a token: a broker holds a GitHub App private key and mints
 * a one-hour, single-repository installation token only while proxying Git
 * smart-HTTP. The sandbox sees neither the key nor the GitHub token.
 */
export function requiredGitCredentialMechanism(repository) {
	return {
		kind: "github-app-installation-token-via-git-proxy",
		repository: validateRepositoryCapability(repository),
		permissions: ["contents:write", "pull_requests:write", "metadata:read"],
		installationScope: "single-repository",
		maxLifetimeSeconds: 3600,
		sandboxReceivesGitHubToken: false,
		brokerRequirements: [
			"validate a short-lived execution assertion bound to job, repository, branch, and generation",
			"inject the GitHub App installation token only into the outgoing Git smart-HTTP request",
			"reject non-allowlisted repository paths, branch escapes, and expired assertions",
			"audit each capability and Git HTTP operation without logging credentials",
		],
	};
}

/**
 * Static command specifications. The execution service maps these IDs to
 * fixed argv arrays; user prose, target text, issue bodies, and model output
 * never become shell input.
 */
export const NATIVE_GIT_COMMANDS = Object.freeze({
	"inspect-status": ["git", "status", "--short"],
	"inspect-diff": ["git", "diff", "--check"],
	"run-types": ["npm", "run", "cf-typegen"],
	"run-typecheck": ["npx", "tsc", "--noEmit"],
	"inspect-head": ["git", "rev-parse", "HEAD"],
});

/** @param {string} branch */
function branchRef(branch) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..") || branch.endsWith("/")) {
		throw new Error("A planned branch must be a normalized Git branch name.");
	}
	return branch;
}

/**
 * Translate one durable App Harness work item into a pure Cloudflare OS job
 * description. This is the explicit provider seam: only sanitized provenance
 * and identifiers cross it. No browser form values, secrets, source, model
 * response, or credential material is accepted.
 *
 * @param {{ workItemId: string, room: string, issueUrl: string, repository: string, stack: import('./stack-scheduler.js').StackLedger, target?: { targetId?: string, page?: string } }} input
 */
export function prepareNativeGitJob(input) {
	const workItemId = requireSafeId(input.workItemId, "Work item ID");
	const room = requireSafeId(input.room, "Room");
	const repository = validateRepositoryCapability(input.repository);
	if (typeof input.issueUrl !== "string" || !input.issueUrl.startsWith(`https://github.com/${repository}/issues/`)) {
		throw new Error("A job must carry a GitHub issue URL for its allowed repository.");
	}
	const stack = validateStack(structuredClone(input.stack));
	if (stack.rootIssueUrl !== input.issueUrl) throw new Error("Stack root issue must match the submitted work item.");
	const targetId = input.target?.targetId;
	if (targetId !== undefined) requireSafeId(targetId, "Target ID");

	const workspacePath = "/workspace/repository";
	const nodePlans = stack.nodes.map((node, index) => ({
		nodeId: node.id,
		branch: branchRef(node.branch),
		parentBranch: index === 0 ? "main" : branchRef(stack.nodes[index - 1].branch),
		pullRequestBase: index === 0 ? "main" : branchRef(stack.nodes[index - 1].branch),
		intent: node.intent.slice(0, 280),
	}));

	return {
		version: 1,
		mode: "preflight-only",
		provider: "cloudflare-os-sandbox",
		jobId: `os-${workItemId}-g${stack.generation}`,
		provenance: { workItemId, room, issueUrl: input.issueUrl, ...(targetId && { targetId }) },
		repositoryCapability: {
			repository,
			resourceUrl: `https://github.com/${repository}`,
			access: "native-git-via-proxy-only",
		},
		credential: requiredGitCredentialMechanism(repository),
		workspace: {
			sandboxName: `app-harness-${workItemId}-g${stack.generation}`,
			defaultSession: "disabled",
			candidateDirectory: workspacePath,
			checkout: {
				remote: `https://github.com/${repository}.git`,
				branch: "main",
				targetDir: workspacePath,
				depth: 1,
				credentialDelivery: "git-proxy-only",
			},
		},
		stack: {
			id: stack.id,
			lane: stack.lane,
			baseSha: stack.baseSha,
			generation: stack.generation,
			ci: {
				concurrencyGroup: stackConcurrencyGroup(stack),
				runKey: stackConcurrencyKey(stack),
				cancelInProgress: true,
			},
			nodes: nodePlans,
			restack: restackPlan(stack),
		},
		commandPolicy: {
			allowlistedCommandIds: Object.keys(NATIVE_GIT_COMMANDS),
			commandsUseFixedArgv: true,
			allowRawShell: false,
		},
	};
}

/**
 * Produce a bounded, privacy-safe event for the Durable Object ledger. This
 * intentionally records command IDs and outcome summaries, not raw stdout,
 * prompts, source content, or tokens.
 */
export function createNativeGitAuditEvent({ jobId, kind, at = Date.now(), nodeId, commandId, exitCode, detail }) {
	requireSafeId(jobId, "Job ID");
	if (!AUDIT_KINDS.has(kind)) throw new Error("Unsupported native-Git audit event.");
	if (nodeId !== undefined) requireSafeId(nodeId, "Node ID");
	if (commandId !== undefined && !(commandId in NATIVE_GIT_COMMANDS)) {
		throw new Error("Audit event references a command outside the allowlist.");
	}
	if (exitCode !== undefined && (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)) {
		throw new Error("Audit event exit code is invalid.");
	}
	return {
		type: "os-native-git:audit",
		jobId,
		kind,
		at,
		...(nodeId && { nodeId }),
		...(commandId && { commandId }),
		...(exitCode !== undefined && { exitCode }),
		...(typeof detail === "string" && detail.trim() && { detail: detail.trim().slice(0, 280) }),
	};
}
