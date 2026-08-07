/**
 * Pure durable stack orchestration state.
 *
 * This module performs no I/O. Callers persist the returned ledger before
 * starting an external side effect, then correlate the eventual response with
 * the recorded generation, node, attempt token, dispatch key, and immutable
 * head. Replaying an applied event is a no-op.
 */

const SHA = /^[0-9a-f]{40}$/iu;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u;
const BRANCH_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,139}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TERMINAL_LEDGER_STATES = new Set(["blocked", "cancelled", "completed"]);
const TERMINAL_NODE_STATES = new Set(["failed", "closed", "merged"]);

/** @param {unknown} value @param {string} label */
function safeId(value, label) {
	if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a bounded identifier.`);
	return value;
}

/** @param {unknown} value @param {string} label */
function sha(value, label) {
	if (typeof value !== "string" || !SHA.test(value)) throw new Error(`${label} must be a full Git SHA.`);
	return value.toLowerCase();
}

/** @param {unknown} value @param {string} label */
function positiveInteger(value, label) {
	if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
	return value;
}

/** @param {unknown} value @param {string} label */
function nonNegativeInteger(value, label) {
	if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
	return value;
}

/** @param {unknown} value @param {string} label */
function branchPrefix(value, label) {
	if (
		typeof value !== "string" ||
		!BRANCH_PREFIX.test(value) ||
		value.includes("..") ||
		value.endsWith("/") ||
		value.includes("@{") ||
		value.endsWith(".lock")
	) throw new Error(`${label} must be a normalized Git branch prefix.`);
	return value;
}

/** @param {string} prefix @param {number} generation */
export function branchForGeneration(prefix, generation) {
	return `${branchPrefix(prefix, "Branch prefix")}/g${positiveInteger(generation, "Generation")}`;
}

/** @param {string} stackId @param {number} generation @param {string} nodeId @param {string} headSha @param {string} baseSha */
export function promotionKey(stackId, generation, nodeId, headSha, baseSha) {
	return `${safeId(stackId, "Stack ID")}:g${positiveInteger(generation, "Generation")}:${safeId(nodeId, "Node ID")}:${sha(headSha, "Promotion head")}:${sha(baseSha, "Promotion base")}`;
}

/** @param {any} ledger */
export function stackCancellationGroup(ledger) {
	validateStackLedger(ledger);
	return `app-harness-stack-${ledger.id}`;
}

/**
 * @param {{
 *   id: string,
 *   repository: string,
 *   lane: string,
 *   issue: { number: number, url: string, updatedAt?: string },
 *   baseSha: string,
 *   nativeStackId?: string,
 *   nodes: Array<{ id: string, intent: string, branchPrefix: string }>,
 * }} input
 */
export function createStackLedger(input) {
	if (!input || typeof input !== "object") throw new Error("Stack ledger input is required.");
	const id = safeId(input.id, "Stack ID");
	const lane = safeId(input.lane, "Lane");
	if (typeof input.repository !== "string" || !REPOSITORY.test(input.repository)) throw new Error("Repository must be owner/name.");
	const repository = input.repository.toLowerCase();
	const issueNumber = positiveInteger(input.issue?.number, "Issue number");
	const expectedIssueUrl = `https://github.com/${repository}/issues/${issueNumber}`;
	if (input.issue?.url !== expectedIssueUrl) throw new Error("Issue URL must match the ledger repository and issue number.");
	const originalBaseSha = sha(input.baseSha, "Original base");
	if (!Array.isArray(input.nodes) || input.nodes.length === 0) throw new Error("A stack needs at least one node.");
	const ids = new Set();
	const prefixes = new Set();
	const nodes = input.nodes.map((node, index) => {
		const nodeId = safeId(node.id, "Node ID");
		const prefix = branchPrefix(node.branchPrefix, "Node branch prefix");
		if (ids.has(nodeId)) throw new Error("Stack node IDs must be unique.");
		if (prefixes.has(prefix)) throw new Error("Stack branch prefixes must be unique.");
		if (typeof node.intent !== "string" || !node.intent.trim()) throw new Error("Each stack node needs an intent.");
		ids.add(nodeId);
		prefixes.add(prefix);
		return {
			id: nodeId,
			intent: node.intent.trim(),
			branchPrefix: prefix,
			branch: branchForGeneration(prefix, 1),
			parentId: index === 0 ? null : input.nodes[index - 1].id,
			parentBranch: index === 0 ? "main" : branchForGeneration(input.nodes[index - 1].branchPrefix, 1),
			parentBaseSha: index === 0 ? originalBaseSha : null,
			generation: 1,
			state: "ready",
			headSha: null,
			pullRequest: null,
		};
	});
	const mode = nodes.length === 1 ? "one-node-stack" : "multi-restack";
	// `gh stack init` tracks a one-node stack locally. GitHub only creates a
	// remote Stack object when it has a chain to link, so a remote ID is neither
	// available nor required for the one-node path.
	if (mode === "one-node-stack" && input.nativeStackId !== undefined) throw new Error("A one-node stack has no remote GitHub Stack identity.");
	const nativeStack = mode === "multi-restack"
		? { id: safeId(input.nativeStackId, "Native GitHub stack ID"), generation: 1, order: nodes.map((node) => node.id), stage: "pending", attempt: 0, attemptToken: null }
		: null;
	const ledger = {
		schemaVersion: 1,
		id,
		repository,
		lane,
		mode,
		nativeStack,
		status: "active",
		revision: 1,
		generation: 1,
		originalBaseSha,
		currentBaseSha: originalBaseSha,
		generationBaseSha: originalBaseSha,
		issue: {
			number: issueNumber,
			url: expectedIssueUrl,
			state: "open",
			authority: "active",
			updatedAt: typeof input.issue.updatedAt === "string" ? input.issue.updatedAt : null,
		},
		nodes,
		runner: { stage: "pending", attempt: 0, nodeId: nodes[0].id, attemptToken: null },
		promotion: { stage: "idle", nodeId: null, dispatchKey: null, runId: null, headSha: null, mergeSha: null },
		deployment: { stage: "idle", attempt: 0, attemptToken: null, mergeSha: null, deploymentUrl: null },
		integration: { required: true, validatedBaseSha: null, validatedHeadSha: null },
		appliedEventIds: [],
	};
	return validateStackLedger(ledger);
}

/** @param {any} ledger */
export function validateStackLedger(ledger) {
	if (!ledger || typeof ledger !== "object" || ledger.schemaVersion !== 1) throw new Error("Unsupported stack ledger.");
	safeId(ledger.id, "Stack ID");
	safeId(ledger.lane, "Lane");
	if (typeof ledger.repository !== "string" || !REPOSITORY.test(ledger.repository)) throw new Error("Ledger repository is invalid.");
	positiveInteger(ledger.revision, "Revision");
	positiveInteger(ledger.generation, "Generation");
	sha(ledger.originalBaseSha, "Original base");
	sha(ledger.currentBaseSha, "Current base");
	sha(ledger.generationBaseSha, "Generation base");
	if (!Array.isArray(ledger.nodes) || !ledger.nodes.length) throw new Error("Ledger nodes are required.");
	if (ledger.mode !== (ledger.nodes.length === 1 ? "one-node-stack" : "multi-restack")) throw new Error("Stack mode must match its node count.");
	if (ledger.mode === "one-node-stack" && ledger.nativeStack !== null) throw new Error("A one-node stack cannot claim a remote GitHub Stack identity.");
	if (ledger.mode === "multi-restack") {
		if (!ledger.nativeStack || typeof ledger.nativeStack !== "object") throw new Error("Dependent nodes require a native GitHub stack identity.");
		safeId(ledger.nativeStack.id, "Native GitHub stack ID");
		if (ledger.nativeStack.generation !== ledger.generation) throw new Error("Native GitHub stack generation must match the durable generation.");
		const expectedNativeOrder = ledger.nodes.filter((node) => node.state !== "merged").map((node) => node.id);
		if (!Array.isArray(ledger.nativeStack.order) || ledger.nativeStack.order.length !== expectedNativeOrder.length || ledger.nativeStack.order.some((nodeId, index) => nodeId !== expectedNativeOrder[index])) {
			throw new Error("Native GitHub stack order must match durable node order.");
		}
		if (!["pending", "syncing", "retry-pending", "synced", "complete"].includes(ledger.nativeStack.stage)) throw new Error("Native GitHub stack reconciliation stage is invalid.");
		nonNegativeInteger(ledger.nativeStack.attempt, "Native GitHub stack attempt");
		if (ledger.nativeStack.attemptToken !== null) safeId(ledger.nativeStack.attemptToken, "Native GitHub stack attempt token");
		if ((expectedNativeOrder.length === 0) !== (ledger.nativeStack.stage === "complete")) throw new Error("Native GitHub stack completion must match durable node completion.");
	}
	if (!["active", "needs-restack", "restacking", "blocked", "cancelled", "completed"].includes(ledger.status)) throw new Error("Ledger status is invalid.");
	positiveInteger(ledger.issue?.number, "Issue number");
	if (ledger.issue.url !== `https://github.com/${ledger.repository}/issues/${ledger.issue.number}`) throw new Error("Ledger issue authority does not match its repository.");
	if (!["open", "closed"].includes(ledger.issue.state) || !["active", "cancelled", "completed"].includes(ledger.issue.authority)) throw new Error("Ledger issue authority is invalid.");
	if (!["pending", "running", "retry-pending", "restack-pending", "complete", "failed", "cancelled"].includes(ledger.runner?.stage)) throw new Error("Runner stage is invalid.");
	nonNegativeInteger(ledger.runner.attempt, "Runner attempt");
	if (ledger.runner.nodeId !== null) safeId(ledger.runner.nodeId, "Runner node ID");
	if (ledger.runner.attemptToken !== null) safeId(ledger.runner.attemptToken, "Runner attempt token");
	if (!["idle", "candidate-ready", "dispatch-pending", "dispatched", "validating", "validated", "merging", "merged", "blocked", "cancelled"].includes(ledger.promotion?.stage)) throw new Error("Promotion stage is invalid.");
	if (ledger.promotion.nodeId !== null) safeId(ledger.promotion.nodeId, "Promotion node ID");
	if (ledger.promotion.headSha !== null) sha(ledger.promotion.headSha, "Promotion head");
	if (ledger.promotion.mergeSha !== null) sha(ledger.promotion.mergeSha, "Promotion merge");
	if (!["idle", "pending", "deploying", "retry-pending", "deployed", "blocked", "cancelled"].includes(ledger.deployment?.stage)) throw new Error("Deployment stage is invalid.");
	nonNegativeInteger(ledger.deployment.attempt, "Deployment attempt");
	if (ledger.deployment.attemptToken !== null) safeId(ledger.deployment.attemptToken, "Deployment attempt token");
	if (ledger.deployment.mergeSha !== null) sha(ledger.deployment.mergeSha, "Deployment merge");
	if (typeof ledger.integration?.required !== "boolean") throw new Error("Integration requirement is invalid.");
	if (ledger.integration.validatedBaseSha !== null) sha(ledger.integration.validatedBaseSha, "Validated integration base");
	if (ledger.integration.validatedHeadSha !== null) sha(ledger.integration.validatedHeadSha, "Validated integration head");
	const ids = new Set();
	for (let index = 0; index < ledger.nodes.length; index += 1) {
		const node = ledger.nodes[index];
		safeId(node.id, "Node ID");
		if (ids.has(node.id)) throw new Error("Stack node IDs must be unique.");
		ids.add(node.id);
		branchPrefix(node.branchPrefix, "Node branch prefix");
		if (node.branch !== branchForGeneration(node.branchPrefix, node.generation)) throw new Error("Node branch must be derived from its generation.");
		if (node.generation !== ledger.generation && node.state !== "merged") throw new Error("Every unmerged node must belong to the current generation.");
		if (index === 0 && node.parentId !== null) throw new Error("The first node cannot have a parent ID.");
		if (index > 0 && node.parentId !== ledger.nodes[index - 1].id) throw new Error("Nodes must retain immediate predecessor ownership.");
		if (node.headSha !== null) sha(node.headSha, "Node head");
		if (node.parentBaseSha !== null) sha(node.parentBaseSha, "Node parent base");
		if (!["ready", "running", "candidate", "passed", "needs-restack", "blocked", "failed", "closed", "merged"].includes(node.state)) throw new Error("Node state is invalid.");
	}
	if (!Array.isArray(ledger.appliedEventIds) || new Set(ledger.appliedEventIds).size !== ledger.appliedEventIds.length) {
		throw new Error("Applied event IDs are invalid.");
	}
	for (const eventId of ledger.appliedEventIds) safeId(eventId, "Applied event ID");
	if (ledger.status === "cancelled" && ledger.issue.authority !== "cancelled") throw new Error("Cancelled work must relinquish issue authority.");
	if (ledger.status === "completed" && (ledger.issue.authority !== "completed" || ledger.deployment.stage !== "deployed" || ledger.nodes.some((node) => node.state !== "merged"))) {
		throw new Error("Completed work requires a deployed, fully merged stack.");
	}
	return ledger;
}

/** @param {any} ledger */
function nextUnbuiltNode(ledger) {
	return ledger.nodes.find((node) => node.state !== "merged" && node.headSha === null) ?? null;
}

/** @param {any} ledger */
function nextPromotionNode(ledger) {
	return ledger.nodes.find((node) => node.state !== "merged") ?? null;
}

/** @param {any} ledger @param {string} eventId */
function withAppliedEvent(ledger, eventId) {
	return {
		...ledger,
		revision: ledger.revision + 1,
		appliedEventIds: [...ledger.appliedEventIds, eventId],
	};
}

/** @param {any} ledger @param {string} disposition @param {string} reason */
function result(ledger, disposition, reason) {
	return { ledger, disposition, reason };
}

/** @param {any} ledger @param {any} event */
function eventPrelude(ledger, event) {
	validateStackLedger(ledger);
	if (!event || typeof event !== "object") throw new Error("A stack event is required.");
	const eventId = safeId(event.eventId, "Event ID");
	if (ledger.appliedEventIds.includes(eventId)) return result(ledger, "duplicate", "event-already-applied");
	if (!Number.isInteger(event.generation) || event.generation !== ledger.generation) return result(ledger, "stale", "generation-mismatch");
	if (event.expectedRevision !== undefined && event.expectedRevision !== ledger.revision) return result(ledger, "stale", "revision-mismatch");
	if (TERMINAL_LEDGER_STATES.has(ledger.status)) return result(ledger, "stale", "ledger-terminal");
	return null;
}

/** @param {any} ledger @param {any} event @param {(next: any) => any} mutate */
function apply(ledger, event, mutate) {
	const next = withAppliedEvent(mutate(ledger), event.eventId);
	validateStackLedger(next);
	return result(next, "applied", "applied");
}

/**
 * Apply one correlated external or orchestration event.
 *
 * Dispositions are `applied`, `duplicate`, or `stale`. Structurally invalid
 * events and impossible current-generation transitions throw.
 *
 * @param {any} ledger
 * @param {any} event
 */
export function applyStackEvent(ledger, event) {
	const ignored = eventPrelude(ledger, event);
	if (ignored) return ignored;

	switch (event.type) {
		case "issue-closed": {
			if (event.issueNumber !== ledger.issue.number) return result(ledger, "stale", "issue-mismatch");
			return apply(ledger, event, (current) => ({
				...current,
				status: "cancelled",
				issue: { ...current.issue, state: "closed", authority: "cancelled", updatedAt: event.updatedAt ?? current.issue.updatedAt },
				nodes: current.nodes.map((node) => node.state === "merged" ? node : { ...node, state: "closed" }),
				runner: { ...current.runner, stage: "cancelled", attemptToken: null },
				promotion: { ...current.promotion, stage: "cancelled" },
				deployment: { ...current.deployment, stage: "cancelled", attemptToken: null },
			}));
		}

		case "main-observed": {
			const observed = sha(event.mainSha, "Observed main");
			if (observed === ledger.currentBaseSha) return result(ledger, "stale", "main-unchanged");
			// A completed single-node candidate is immutable. A main advance only
			// invalidates its integration proof; CI will validate the same head
			// against the new main. Before a candidate exists, however, the root
			// must advance once just like the root of a larger stack.
			if (ledger.mode === "one-node-stack" && ledger.nodes[0].headSha) {
				return apply(ledger, event, (current) => ({
					...current,
					currentBaseSha: observed,
					integration: { required: true, validatedBaseSha: null, validatedHeadSha: null },
					promotion: current.promotion.stage === "merged"
						? current.promotion
						: { stage: current.nodes[0].headSha ? "candidate-ready" : "idle", nodeId: current.nodes[0].headSha ? current.nodes[0].id : null, dispatchKey: null, runId: null, headSha: current.nodes[0].headSha, mergeSha: null },
				}));
			}
			return apply(ledger, event, (current) => ({
				...current,
				status: "needs-restack",
				currentBaseSha: observed,
				nodes: current.nodes.map((node) => node.state === "merged" ? node : { ...node, state: "needs-restack" }),
				runner: { ...current.runner, stage: "restack-pending", attemptToken: null },
				promotion: { stage: "idle", nodeId: null, dispatchKey: null, runId: null, headSha: null, mergeSha: null },
				integration: { required: true, validatedBaseSha: null, validatedHeadSha: null },
			}));
		}

		case "restack-started": {
			if (ledger.status !== "needs-restack") throw new Error("Only a stack needing restack can begin a new generation.");
			const generation = ledger.generation + 1;
			const firstActiveIndex = ledger.nodes.findIndex((node) => node.state !== "merged");
			if (firstActiveIndex < 0) throw new Error("A fully merged stack cannot restack.");
			return apply(ledger, event, (current) => {
				const nodes = current.nodes.map((node, index) => {
					if (node.state === "merged") return node;
					const previous = index > 0 ? current.nodes[index - 1] : null;
					const previousIsMerged = !previous || previous.state === "merged";
					return {
						...node,
						branch: branchForGeneration(node.branchPrefix, generation),
						parentBranch: previousIsMerged ? "main" : branchForGeneration(previous.branchPrefix, generation),
						parentBaseSha: index === firstActiveIndex ? current.currentBaseSha : null,
						generation,
						state: "ready",
						headSha: null,
						pullRequest: null,
					};
				});
				return {
					...current,
					generation,
					generationBaseSha: current.currentBaseSha,
					status: "restacking",
					nativeStack: current.mode === "multi-restack"
						? { ...current.nativeStack, generation, order: nodes.filter((node) => node.state !== "merged").map((node) => node.id), stage: "pending", attempt: 0, attemptToken: null }
						: null,
					nodes,
					runner: { stage: "pending", attempt: 0, nodeId: nodes[firstActiveIndex].id, attemptToken: null },
					promotion: { stage: "idle", nodeId: null, dispatchKey: null, runId: null, headSha: null, mergeSha: null },
					integration: { required: true, validatedBaseSha: null, validatedHeadSha: null },
				};
			});
		}

		case "runner-attempt-started": {
			const node = nextUnbuiltNode(ledger);
			if (!node || node.id !== event.nodeId) throw new Error("Runner attempts must build the next ordered node.");
			if (!["pending", "retry-pending"].includes(ledger.runner.stage)) throw new Error("A runner attempt is already active or complete.");
			const attemptToken = safeId(event.attemptToken, "Runner attempt token");
			return apply(ledger, event, (current) => ({
				...current,
				runner: { stage: "running", attempt: current.runner.attempt + 1, nodeId: node.id, attemptToken },
				nodes: current.nodes.map((candidate) => candidate.id === node.id ? { ...candidate, state: "running" } : candidate),
			}));
		}

		case "runner-attempt-retryable": {
			if (ledger.runner.stage !== "running" || event.attemptToken !== ledger.runner.attemptToken) return result(ledger, "stale", "runner-attempt-mismatch");
			return apply(ledger, event, (current) => ({
				...current,
				runner: { ...current.runner, stage: "retry-pending", attemptToken: null },
				nodes: current.nodes.map((node) => node.id === current.runner.nodeId ? { ...node, state: "ready" } : node),
			}));
		}

		case "runner-attempt-failed": {
			if (ledger.runner.stage !== "running" || event.attemptToken !== ledger.runner.attemptToken) return result(ledger, "stale", "runner-attempt-mismatch");
			const failedIndex = ledger.nodes.findIndex((node) => node.id === ledger.runner.nodeId);
			return apply(ledger, event, (current) => ({
				...current,
				status: "blocked",
				runner: { ...current.runner, stage: "failed", attemptToken: null },
				nodes: current.nodes.map((node, index) => index === failedIndex ? { ...node, state: "failed" } : index > failedIndex && node.state !== "merged" ? { ...node, state: "blocked" } : node),
				promotion: { ...current.promotion, stage: "blocked" },
				deployment: { ...current.deployment, stage: "blocked" },
			}));
		}

		case "runner-candidate-recorded": {
			if (ledger.runner.stage !== "running" || event.attemptToken !== ledger.runner.attemptToken) return result(ledger, "stale", "runner-attempt-mismatch");
			if (event.nodeId !== ledger.runner.nodeId) return result(ledger, "stale", "runner-node-mismatch");
			const index = ledger.nodes.findIndex((node) => node.id === event.nodeId);
			if (index < 0) throw new Error("Unknown runner node.");
			const node = ledger.nodes[index];
			const previous = index > 0 ? ledger.nodes[index - 1] : null;
			const previousIsMerged = !previous || previous.state === "merged";
			const expectedParentBranch = previousIsMerged ? "main" : previous.branch;
			const expectedParentBase = previousIsMerged ? ledger.generationBaseSha : previous.headSha;
			if (!expectedParentBase) throw new Error("A child cannot be recorded before its parent head.");
			if (event.parentBranch !== expectedParentBranch || sha(event.parentBaseSha, "Candidate parent base") !== expectedParentBase) {
				return result(ledger, "stale", "candidate-parent-mismatch");
			}
			const headSha = sha(event.headSha, "Candidate head");
			const pullRequestNumber = positiveInteger(event.pullRequestNumber, "Pull request number");
			const expectedUrl = `https://github.com/${ledger.repository}/pull/${pullRequestNumber}`;
			if (event.pullRequestUrl !== expectedUrl) throw new Error("Pull request URL must match the ledger repository and number.");
			return apply(ledger, event, (current) => {
				const nodes = current.nodes.map((candidate) => candidate.id === node.id ? {
					...candidate,
					parentBranch: expectedParentBranch,
					parentBaseSha: expectedParentBase,
					headSha,
					state: "candidate",
					pullRequest: { number: pullRequestNumber, url: expectedUrl, state: "open" },
				} : candidate);
				const next = nodes.find((candidate) => candidate.state !== "merged" && candidate.headSha === null) ?? null;
				return {
					...current,
					status: next ? current.status : "active",
					nodes,
					runner: next
						? { stage: "pending", attempt: current.runner.attempt, nodeId: next.id, attemptToken: null }
						: { stage: "complete", attempt: current.runner.attempt, nodeId: null, attemptToken: null },
					promotion: next ? current.promotion : { stage: "candidate-ready", nodeId: nextPromotionNode({ ...current, nodes })?.id ?? null, dispatchKey: null, runId: null, headSha: nextPromotionNode({ ...current, nodes })?.headSha ?? null, mergeSha: null },
				};
			});
		}

		case "node-validation-recorded": {
			const index = ledger.nodes.findIndex((node) => node.id === event.nodeId);
			if (index < 0) throw new Error("Unknown validation node.");
			const node = ledger.nodes[index];
			if (node.generation !== ledger.generation || event.headSha !== node.headSha) return result(ledger, "stale", "validation-head-mismatch");
			if (TERMINAL_NODE_STATES.has(node.state)) return result(ledger, "stale", "node-terminal");
			if (event.outcome !== "passed" && event.outcome !== "failed") throw new Error("Node validation outcome is invalid.");
			return apply(ledger, event, (current) => {
				if (event.outcome === "failed") {
					return {
						...current,
						status: "blocked",
						nodes: current.nodes.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, state: "failed" } : candidateIndex > index && candidate.state !== "merged" ? { ...candidate, state: "blocked" } : candidate),
						promotion: { ...current.promotion, stage: "blocked" },
					};
				}
				return { ...current, nodes: current.nodes.map((candidate) => candidate.id === node.id ? { ...candidate, state: "passed" } : candidate) };
			});
		}

		case "native-stack-sync-started": {
			if (ledger.mode !== "multi-restack" || !ledger.nativeStack) throw new Error("Only a dependent stack needs gh stack synchronization.");
			if (!["pending", "retry-pending"].includes(ledger.nativeStack.stage)) throw new Error("A native GitHub stack sync is already active or complete.");
			const attemptToken = safeId(event.attemptToken, "Native stack attempt token");
			return apply(ledger, event, (current) => ({ ...current, nativeStack: { ...current.nativeStack, stage: "syncing", attempt: current.nativeStack.attempt + 1, attemptToken } }));
		}

		case "native-stack-sync-retryable": {
			if (ledger.mode !== "multi-restack" || !ledger.nativeStack) throw new Error("Only a dependent stack needs gh stack synchronization.");
			if (ledger.nativeStack.stage !== "syncing" || event.attemptToken !== ledger.nativeStack.attemptToken) return result(ledger, "stale", "native-stack-attempt-mismatch");
			return apply(ledger, event, (current) => ({ ...current, nativeStack: { ...current.nativeStack, stage: "retry-pending", attemptToken: null } }));
		}

		case "native-stack-reconciled": {
			if (ledger.mode !== "multi-restack" || !ledger.nativeStack) throw new Error("Only a dependent stack needs gh stack synchronization.");
			if (ledger.nativeStack.stage !== "syncing" || event.attemptToken !== ledger.nativeStack.attemptToken) return result(ledger, "stale", "native-stack-attempt-mismatch");
			if (event.nativeStackId !== ledger.nativeStack.id) return result(ledger, "stale", "native-stack-id-mismatch");
			if (!Array.isArray(event.order) || event.order.length !== ledger.nativeStack.order.length || event.order.some((nodeId, index) => nodeId !== ledger.nativeStack.order[index])) {
				return result(ledger, "stale", "native-stack-order-mismatch");
			}
			return apply(ledger, event, (current) => ({ ...current, nativeStack: { ...current.nativeStack, stage: "synced", attemptToken: null } }));
		}

		case "pull-request-closed": {
			const index = ledger.nodes.findIndex((node) => node.id === event.nodeId);
			if (index < 0) throw new Error("Unknown pull request node.");
			const node = ledger.nodes[index];
			if (node.pullRequest?.number !== event.pullRequestNumber || node.headSha !== event.headSha) return result(ledger, "stale", "pull-request-mismatch");
			return apply(ledger, event, (current) => ({
				...current,
				status: "blocked",
				nodes: current.nodes.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, state: "closed", pullRequest: { ...candidate.pullRequest, state: "closed" } } : candidateIndex > index && candidate.state !== "merged" ? { ...candidate, state: "blocked" } : candidate),
				promotion: { ...current.promotion, stage: "blocked" },
			}));
		}

		case "promotion-planned": {
			if (ledger.mode === "multi-restack" && ledger.nativeStack?.stage !== "synced") throw new Error("Dependent PRs require current gh stack submit/sync reconciliation before promotion.");
			const node = nextPromotionNode(ledger);
			if (!node || node.id !== event.nodeId || node.state !== "passed" || !node.headSha) throw new Error("Only the next validated node can be promoted.");
			const dispatchKey = promotionKey(ledger.id, ledger.generation, node.id, node.headSha, ledger.currentBaseSha);
			if (event.dispatchKey !== dispatchKey) throw new Error("Promotion dispatch key is not deterministic.");
			return apply(ledger, event, (current) => ({ ...current, promotion: { stage: "dispatch-pending", nodeId: node.id, dispatchKey, runId: null, headSha: node.headSha, mergeSha: null } }));
		}

		case "promotion-dispatched": {
			if (ledger.promotion.stage !== "dispatch-pending" || event.dispatchKey !== ledger.promotion.dispatchKey) return result(ledger, "stale", "promotion-dispatch-mismatch");
			return apply(ledger, event, (current) => ({ ...current, promotion: { ...current.promotion, stage: "dispatched", runId: safeId(event.runId, "Promotion run ID") } }));
		}

		case "promotion-validated": {
			if (!["dispatch-pending", "dispatched", "validating"].includes(ledger.promotion.stage) || event.dispatchKey !== ledger.promotion.dispatchKey) return result(ledger, "stale", "promotion-dispatch-mismatch");
			if (event.headSha !== ledger.promotion.headSha) return result(ledger, "stale", "promotion-head-mismatch");
			const validatedBaseSha = sha(event.baseSha, "Validated integration base");
			if (validatedBaseSha !== ledger.currentBaseSha) return result(ledger, "stale", "promotion-base-mismatch");
			return apply(ledger, event, (current) => ({
				...current,
				promotion: { ...current.promotion, stage: "validated" },
				integration: { required: false, validatedBaseSha, validatedHeadSha: current.promotion.headSha },
			}));
		}

		case "promotion-merge-started": {
			if (ledger.promotion.stage !== "validated" || event.dispatchKey !== ledger.promotion.dispatchKey || ledger.integration.required) return result(ledger, "stale", "promotion-not-currently-validated");
			if (event.currentMainSha !== ledger.currentBaseSha || event.headSha !== ledger.promotion.headSha) return result(ledger, "stale", "promotion-final-provenance-mismatch");
			return apply(ledger, event, (current) => ({ ...current, promotion: { ...current.promotion, stage: "merging" } }));
		}

		case "promotion-merged": {
			if (ledger.promotion.stage !== "merging" || event.dispatchKey !== ledger.promotion.dispatchKey || event.headSha !== ledger.promotion.headSha) return result(ledger, "stale", "promotion-merge-mismatch");
			const mergeSha = sha(event.mergeSha, "Merge SHA");
			const index = ledger.nodes.findIndex((node) => node.id === ledger.promotion.nodeId);
			if (index < 0) throw new Error("Promotion node disappeared.");
			return apply(ledger, event, (current) => {
				const nodes = current.nodes.map((node, nodeIndex) => nodeIndex === index ? { ...node, state: "merged", pullRequest: { ...node.pullRequest, state: "merged" }, mergeSha } : nodeIndex > index ? { ...node, state: "needs-restack" } : node);
				const complete = index === nodes.length - 1;
				const remainingOrder = nodes.filter((node) => node.state !== "merged").map((node) => node.id);
				return {
					...current,
					status: complete ? "active" : "needs-restack",
					currentBaseSha: mergeSha,
					nativeStack: current.nativeStack ? { ...current.nativeStack, order: remainingOrder, stage: complete ? "complete" : "pending", attempt: 0, attemptToken: null } : null,
					nodes,
					runner: complete ? current.runner : { stage: "restack-pending", attempt: current.runner.attempt, nodeId: nodes[index + 1].id, attemptToken: null },
					promotion: { ...current.promotion, stage: "merged", mergeSha },
					deployment: complete ? { ...current.deployment, stage: "pending", mergeSha } : current.deployment,
					integration: { required: !complete, validatedBaseSha: complete ? current.integration.validatedBaseSha : null, validatedHeadSha: complete ? current.integration.validatedHeadSha : null },
				};
			});
		}

		case "deployment-attempt-started": {
			if (!ledger.nodes.every((node) => node.state === "merged") || !["pending", "retry-pending"].includes(ledger.deployment.stage)) throw new Error("Deployment can start only after the complete stack is merged.");
			if (event.mergeSha !== ledger.deployment.mergeSha) return result(ledger, "stale", "deployment-merge-mismatch");
			const attemptToken = safeId(event.attemptToken, "Deployment attempt token");
			return apply(ledger, event, (current) => ({ ...current, deployment: { ...current.deployment, stage: "deploying", attempt: current.deployment.attempt + 1, attemptToken } }));
		}

		case "deployment-attempt-retryable": {
			if (ledger.deployment.stage !== "deploying" || event.attemptToken !== ledger.deployment.attemptToken) return result(ledger, "stale", "deployment-attempt-mismatch");
			return apply(ledger, event, (current) => ({ ...current, deployment: { ...current.deployment, stage: "retry-pending", attemptToken: null } }));
		}

		case "deployment-failed": {
			if (ledger.deployment.stage !== "deploying" || event.attemptToken !== ledger.deployment.attemptToken) return result(ledger, "stale", "deployment-attempt-mismatch");
			return apply(ledger, event, (current) => ({ ...current, status: "blocked", deployment: { ...current.deployment, stage: "blocked", attemptToken: null } }));
		}

		case "deployment-succeeded": {
			if (ledger.deployment.stage !== "deploying" || event.attemptToken !== ledger.deployment.attemptToken) return result(ledger, "stale", "deployment-attempt-mismatch");
			if (typeof event.deploymentUrl !== "string" || !/^https:\/\//u.test(event.deploymentUrl)) throw new Error("Deployment URL must be HTTPS.");
			return apply(ledger, event, (current) => ({
				...current,
				status: "completed",
				issue: { ...current.issue, authority: "completed" },
				deployment: { ...current.deployment, stage: "deployed", attemptToken: null, deploymentUrl: event.deploymentUrl },
			}));
		}

		case "coordinator-blocked": {
			return apply(ledger, event, (current) => ({
				...current,
				status: "blocked",
				nodes: current.nodes.map((node) => node.state === "merged" || node.state === "closed" || node.state === "failed" ? node : { ...node, state: "blocked" }),
				runner: { ...current.runner, stage: current.runner.stage === "complete" ? "complete" : "failed", attemptToken: null },
				promotion: { ...current.promotion, stage: current.promotion.stage === "merged" ? "merged" : "blocked" },
				deployment: { ...current.deployment, stage: current.deployment.stage === "deployed" ? "deployed" : "blocked", attemptToken: null },
			}));
		}

		default:
			throw new Error("Unsupported stack event type.");
	}
}
