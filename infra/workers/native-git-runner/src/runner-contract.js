const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;
const RESPONSE_ID = /^[A-Za-z0-9_-]{1,120}$/u;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,80}$/u;

// The coding model the direct-API agent entrypoint drives through the OpenAI
// Responses API. Kept in lockstep with AGENT_MODEL in agent-entrypoint.mjs.
export const AGENT_DEFAULT_MODEL = "gpt-5.3-codex";

function boundedUnique(values, pattern, limit) {
	if (!Array.isArray(values)) return [];
	return [...new Set(values.filter((value) => typeof value === "string" && pattern.test(value)))].slice(0, limit);
}

/** Keep only non-content provenance that is safe to persist in the room ledger. */
export function normalizeAgentSummary(value, expectedModel = AGENT_DEFAULT_MODEL) {
	if (!value || typeof value !== "object") return null;
	const model = typeof value.model === "string" && SAFE_VALUE.test(value.model) ? value.model : expectedModel;
	if (!SAFE_VALUE.test(model)) return null;
	return {
		model,
		responseIds: boundedUnique(value.responseIds, RESPONSE_ID, 12),
		tools: boundedUnique(value.tools, TOOL_NAME, 32),
	};
}

/**
 * Guidance is the safety boundary; the agent's actual capability surface is the
 * three bounded tools the entrypoint implements. The instructions must describe
 * exactly that surface — promising a shell or Git here would make the model
 * hallucinate commands it cannot run and claim checks it never executed.
 */
export function buildAgentInstructions({ repository, issueNumber, branch, stackId, generation }) {
	for (const value of [repository, branch, stackId]) if (typeof value !== "string" || !SAFE_VALUE.test(value)) throw new Error("Agent context is invalid.");
	if (!Number.isInteger(issueNumber) || issueNumber < 1 || !Number.isInteger(generation) || generation < 1) throw new Error("Agent numeric context is invalid.");
	return [
		"You are the coding operator for App Harness, working on a fresh isolated checkout of the repository.",
		"You operate through exactly three tools: read_file, write_file, and list_dir. You have no shell, no network, no package manager, and no Git.",
		"Inspect the relevant parts of the checked-out repository and every applicable AGENTS.md before changing anything.",
		"The default product surface is apps/demo, including both its frontend and backend. packages/react is the reusable overlay, and infra is the delivery system. These are navigation cues, not restrictions: change any of them when the requested outcome genuinely requires it.",
		"Make the smallest coherent repository change that actually solves the request, including tests when appropriate.",
		"Preserve user data and unrelated work. Never read, print, copy, commit, or expose credentials. Refuse illegal, harmful, offensive, intentionally availability-destroying, or externally unsupported work.",
		"Do not claim to have run tests, builds, or commands: you cannot. The execution harness commits your staged writes, submits them through the official gh stack CLI, and CI is the merge and production deployment authority.",
		`The repository is ${repository}; the linked issue is #${issueNumber}; the durable stack is ${stackId} generation ${generation}.`,
		`The execution harness commits your writes to the required node branch ${branch} and attaches the linked issue #${issueNumber}. Do not try to emulate branches, commits, or pull requests in file content.`,
		"This node may sit inside a shared multi-node stack; the harness owns all stack mechanics, so never improvise stacking, rebasing, or merge steps in file content.",
		"When the change is complete, answer in plain text with one or two sentences describing what changed.",
	].join(" ");
}

export function safeAgentFailure(value) {
	return typeof value === "string" && /^[a-z0-9-]{1,80}$/u.test(value) ? value : "agent-run-failed";
}
