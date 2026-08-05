/**
 * Durable-stack state transitions for a future Cloudflare OS executor.
 *
 * This deliberately models the GitHub branch graph rather than pretending a
 * collection of independent PRs is a stack. Every node is based on its direct
 * parent; only the root tracks main. A main advance creates one restack
 * generation, and descendants are regenerated from their parent in order.
 */

/** @typedef {"ready" | "validating" | "passed" | "failed" | "blocked" | "needs-restack"} StackNodeState */

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

/** @param {StackLedger} stack */
export function validateStack(stack) {
	if (!stack.nodes.length) throw new Error("A stack needs a root node.");
	if (stack.nodes[0].parentId) throw new Error("The first stack node must be rooted on main.");
	for (let index = 1; index < stack.nodes.length; index += 1) {
		if (stack.nodes[index].parentId !== stack.nodes[index - 1].id) {
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
 * Begins the only allowed rebase operation: root onto a newer main SHA, then
 * rebuild every descendant from its immediate parent. CI gets a new shared
 * generation, which callers use as their CI concurrency key.
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
 * Records only the current generation. Stale CI callbacks cannot resurrect a
 * superseded branch generation. A failed lower node blocks all descendants.
 * @param {StackLedger} stack
 * @param {string} nodeId
 * @param {number} generation
 * @param {"validating" | "passed" | "failed"} state
 */
export function recordNodeState(stack, nodeId, generation, state) {
	validateStack(stack);
	if (generation !== stack.generation) return stack;
	const index = stack.nodes.findIndex((node) => node.id === nodeId);
	if (index < 0) throw new Error("Unknown stack node.");
	const nodes = stack.nodes.map((node, nodeIndex) => {
		if (nodeIndex === index) return { ...node, state, ciGeneration: generation };
		if (state === "failed" && nodeIndex > index) return { ...node, state: "blocked", ciGeneration: generation };
		return node;
	});
	return {
		...stack,
		state: state === "failed" ? "blocked" : stack.state,
		nodes,
	};
}

/** @param {StackLedger} stack */
export function stackConcurrencyKey(stack) {
	return `app-harness-stack-${stack.id}-generation-${stack.generation}`;
}
