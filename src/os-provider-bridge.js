const REPOSITORY = "callil/autonomous-live-chat";
const RUNNER_URL = "https://app-harness-os-native-git.coda-a.workers.dev";

/**
 * Convert an already-created durable work item into the only job App Harness
 * may offer the OS runner. Deliberately omit freeform request/source/model
 * content: the durable issue and target provenance remain their authorities.
 */
export function createOsNativeGitJob({ workItemId, issueUrl, room = "main", generation = 1 }) {
	if (typeof workItemId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(workItemId)) {
		throw new Error("OS job needs a bounded durable work-item ID.");
	}
	if (typeof issueUrl !== "string" || !new RegExp(`^https://github\\.com/${REPOSITORY}/issues/\\d+$`, "i").test(issueUrl)) {
		throw new Error("OS job needs the linked issue for the allowlisted repository.");
	}
	if (typeof room !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(room)) {
		throw new Error("OS job needs a bounded room ID.");
	}
	if (!Number.isInteger(generation) || generation < 1) throw new Error("OS job generation is invalid.");
	const jobId = `os-${workItemId}-g${generation}`;
	return {
		jobId,
		repository: REPOSITORY,
		generation,
		issueUrl,
		room,
		stack: {
			id: `stack-${workItemId}`,
			lane: `room-${room}`,
			generation,
			baseSha: null,
			state: "awaiting-base-sha",
		},
		audit: ["job-prepared", "repository-capability-requested"],
		runnerUrl: RUNNER_URL,
	};
}

/** Map only actual runner responses into truthful Durable Object states. */
export function classifyOsRunnerResponse(value) {
	const state = value && typeof value === "object" ? value.state : undefined;
	if (state === "checked-out") return { phase: "building", detail: "Cloudflare OS isolated workspace checked out the allowed repository.", terminal: false };
	if (state === "credential-bridge-required") return { phase: "needs_review", detail: "Cloudflare OS runner is reachable, but native Git is blocked until the repository credential bridge is enabled.", terminal: true };
	if (state === "checkout-failed") return { phase: "needs_review", detail: "Cloudflare OS native checkout failed. No branch, pull request, or deployment was created.", terminal: true };
	return { phase: "needs_review", detail: "Cloudflare OS runner returned an unrecognized status. No native Git action is claimed.", terminal: true };
}

export { REPOSITORY as OS_NATIVE_GIT_REPOSITORY, RUNNER_URL as OS_NATIVE_GIT_RUNNER_URL };
