/**
 * Durable stack state transitions for a future Cloudflare OS executor.
 *
 * This module deliberately describes a GitHub branch graph; it does not run
 * Git or talk to GitHub. Each node bases on its direct parent. The root alone
 * follows main, so a stack cannot degrade into independent PRs chasing main.
 */

/** @typedef {"ready" | "validating" | "passed" | "failed" | "blocked" | "needs-restack" | "merged" | "closed"} StackNodeState */

/**
 * @typedef {{
 *   id: string,
 *   branch: string,
 *   parentId?: string,
 *   intent: string,
 *   state: StackNodeState,
 *   ciGeneration?: number,
 *   pullRequestUrl?: string,
 * }} StackNode
 */

/**
 * @typedef {{
 *   id: string,
 *   rootIssueUrl: string,
 *   lane: string,
 *   baseSha: string,
 *   generation: number,
 *   state: "ready" | "needs-restack" | "blocked" | "complete",
 *   nodes: StackNode[],
 * }} StackLedger
 */

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** @param {StackLedger} stack */
export function validateStack(stack) {
	if (!stack || typeof stack !== "object") throw new Error("A stack ledger is required.");
	if (!Array.isArray(stack.nodes) || !stack.nodes.length) throw new Error("A stack needs a root node.");
	if (!Number.isInteger(stack.generation) || stack.generation < 1) throw new Error("A stack needs a positive generation.");
	if (!stack.baseSha || typeof stack.baseSha !== "string") throw new Error("A stack needs one root base SHA.");
	if (stack.nodes[0].parentId) throw new Error("The first stack node must be rooted on main.");
	const nodeIds = new Set();
	const branches = new Set();
	for (let index = 0; index < stack.nodes.length; index += 1) {
		const node = stack.nodes[index];
		if (!node.id || nodeIds.has(node.id)) throw new Error("Stack node IDs must be unique.");
		if (!BRANCH_PATTERN.test(node.branch) || node.branch.includes("..") || node.branch.endsWith("/")) {
			throw new Error("Stack branches must be normalized Git branch names.");
		}
		if (branches.has(node.branch)) throw new Error("Stack branches must be unique.");
		nodeIds.add(node.id);
		branches.add(node.branch);
		if (index > 0 && node.parentId !== stack.nodes[index - 1].id) {
			throw new Error("Each stack node must base on its immediate predecessor.");
		}
	}
	return stack;
}

/** @param {StackLedger} stack @param {string} latestMainSha */
export function markMainAdvanced(stack, latestMainSha) {
	validateStack(stack);
	if (latestMainSha === stack.baseSha) return stack;
	return {
		...stack,
		state: "needs-restack",
		nodes: stack.nodes.map((node) => ({ ...node, state: "needs-restack" })),
	};
}

/**
 * Builds the only legal restack plan. The executor must rebase the root onto
 * main once, then recreate each descendant from the preceding node. It must
 * never independently rebase a descendant onto main.
 * @param {StackLedger} stack
 */
export function restackPlan(stack) {
	validateStack(stack);
	if (stack.state === "blocked") return [];
	return stack.nodes.map((node, index) => ({
		nodeId: node.id,
		branch: node.branch,
		base: index === 0 ? "main" : stack.nodes[index - 1].branch,
		operation: index === 0 ? "rebase-root-on-main" : "recreate-child-from-parent",
	}));
}

/**
 * Begins a new generation after the executor has the current main SHA. A
 * caller must run restackPlan() in order; this transition alone does not run
 * Git, push a branch, or report a PR as current.
 * @param {StackLedger} stack
 * @param {string} latestMainSha
 */
export function restackFromRoot(stack, latestMainSha) {
	validateStack(stack);
	if (stack.state === "blocked") return stack;
	const generation = stack.generation + 1;
	return {
		...stack,
		baseSha: latestMainSha,
		generation,
		state: "ready",
		nodes: stack.nodes.map((node) => ({ ...node, state: "ready", ciGeneration: generation })),
	};
}

/**
 * Records only the current generation. A failure, closure, or explicit block
 * at a lower node blocks all descendants. Stale CI callbacks cannot revive a
 * superseded stack generation.
 * @param {StackLedger} stack
 * @param {string} nodeId
 * @param {number} generation
 * @param {"validating" | "passed" | "failed" | "closed" | "merged"} state
 */
export function recordNodeState(stack, nodeId, generation, state) {
	validateStack(stack);
	if (generation !== stack.generation) return stack;
	const index = stack.nodes.findIndex((node) => node.id === nodeId);
	if (index < 0) throw new Error("Unknown stack node.");
	const terminalBlock = state === "failed" || state === "closed";
	const nodes = stack.nodes.map((node, nodeIndex) => {
		if (nodeIndex === index) return { ...node, state, ciGeneration: generation };
		if (terminalBlock && nodeIndex > index) return { ...node, state: "blocked", ciGeneration: generation };
		return node;
	});
	return {
		...stack,
		state: terminalBlock ? "blocked" : stack.state,
		nodes,
	};
}

/**
 * A merge below the tip does not claim the entire stack is production-ready.
 * The remaining descendants are marked for one root-led restack against the
 * new main, rather than chasing it independently.
 * @param {StackLedger} stack
 * @param {string} nodeId
 * @param {number} generation
 */
export function markLowerMerged(stack, nodeId, generation) {
	validateStack(stack);
	if (generation !== stack.generation) return stack;
	const index = stack.nodes.findIndex((node) => node.id === nodeId);
	if (index < 0) throw new Error("Unknown stack node.");
	const nodes = stack.nodes.map((node, nodeIndex) => {
		if (nodeIndex === index) return { ...node, state: "merged", ciGeneration: generation };
		if (nodeIndex > index) return { ...node, state: "needs-restack", ciGeneration: generation };
		return node;
	});
	return { ...stack, state: index < stack.nodes.length - 1 ? "needs-restack" : stack.state, nodes };
}

/** Stable CI cancellation group: a newer generation cancels stale runs. */
/** @param {StackLedger} stack */
export function stackConcurrencyGroup(stack) {
	return `app-harness-stack-${stack.id}`;
}

/** Immutable audit/run key inside the stable cancellation group. */
/** @param {StackLedger} stack */
export function stackConcurrencyKey(stack) {
	return `${stackConcurrencyGroup(stack)}-generation-${stack.generation}`;
}
