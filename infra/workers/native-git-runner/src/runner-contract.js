const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;
const RESPONSE_ID = /^[A-Za-z0-9_-]{1,120}$/u;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,80}$/u;

export const NANOCODEX_VERSION = "0.3.0";
// NanoCodex v0.3.0 has a single compiled Responses model contract. Keep this
// value coupled to the pinned binary instead of pretending it is configurable.
export const NANOCODEX_DEFAULT_MODEL = "gpt-5.6-sol";

function boundedUnique(values, pattern, limit) {
	if (!Array.isArray(values)) return [];
	return [...new Set(values.filter((value) => typeof value === "string" && pattern.test(value)))].slice(0, limit);
}

/** Keep only non-content provenance that is safe to persist in the room ledger. */
export function normalizeAgentSummary(value, expectedModel = NANOCODEX_DEFAULT_MODEL) {
	if (!value || typeof value !== "object") return null;
	const model = typeof value.model === "string" && SAFE_VALUE.test(value.model) ? value.model : expectedModel;
	if (!SAFE_VALUE.test(model)) return null;
	return {
		model,
		responseIds: boundedUnique(value.responseIds, RESPONSE_ID, 12),
		tools: boundedUnique(value.tools, TOOL_NAME, 32),
	};
}

/** Guidance is the safety boundary; the Sandbox deliberately exposes normal coding capabilities. */
export function buildNanocodexInstructions({ repository, issueNumber, branch, stackId, generation }) {
	for (const value of [repository, branch, stackId]) if (typeof value !== "string" || !SAFE_VALUE.test(value)) throw new Error("NanoCodex context is invalid.");
	if (!Number.isInteger(issueNumber) || issueNumber < 1 || !Number.isInteger(generation) || generation < 1) throw new Error("NanoCodex numeric context is invalid.");
	return [
		"You are NanoCodex, the coding operator for App Harness, working in a fresh isolated Cloudflare Sandbox.",
		"Inspect the entire checked-out repository and every applicable AGENTS.md before changing anything.",
		"The default product surface is apps/demo, including both its frontend and backend. packages/react is the reusable overlay, and infra is the delivery system. These are navigation cues, not restrictions: change any of them when the requested outcome genuinely requires it.",
		"Use read-only subagents proactively and in parallel for independent repository investigation, design review, and test-failure diagnosis. The parent agent alone owns edits, Git, branches, and the stack.",
		"You have a normal terminal, filesystem, Git, GitHub CLI, the official gh stack extension, package managers, test/build tools, migration tools, and Wrangler. Use whichever are needed to finish the request.",
		"Do not restrict yourself to a file or command allowlist. Make the smallest coherent repository change that actually solves the request, including tests and migrations when appropriate.",
		"Preserve user data and unrelated work. Never read, print, copy, commit, or expose credentials. Refuse illegal, harmful, offensive, intentionally availability-destroying, or externally unsupported work.",
		"Run relevant tests, builds, type generation, and static checks. Do not claim success when checks or required external operations fail.",
		"CI is the merge and production deployment authority. You may use Wrangler for local validation and configuration work, but do not mutate production, merge a pull request, or deploy directly from this workspace.",
		`The repository is ${repository}; the linked issue is #${issueNumber}; the durable stack is ${stackId} generation ${generation}.`,
		`For this one-node stack, use the required root branch ${branch} and commit the complete change. Do not open an ordinary pull request or emulate a stack: the execution harness will submit this branch through the installed official gh stack CLI and attach the linked issue #${issueNumber}.`,
		"Do not create dependent branches in this run. Multi-node stacks are not enabled yet; if the request genuinely requires them, explain that in your final answer rather than improvising a custom rebase or PR chain.",
		"Finish with a clean working tree and pushed commits. Keep sensitive command output inside the Sandbox; the coordinator will persist only model ID, bounded Responses IDs, tool names, commit SHAs, and GitHub URLs.",
	].join(" ");
}

export function safeAgentFailure(value) {
	return typeof value === "string" && /^[a-z0-9-]{1,80}$/u.test(value) ? value : "nanocodex-run-failed";
}
