/**
 * Room-stack contracts: every pending request in a room rides ONE server-side
 * linear GitHub stack, merged bottom-up. These are pure transforms over one
 * plain serializable record — the room Durable Object owns nothing here but
 * persistence and transactions. The one-node stack is the degenerate case:
 * with an empty stack every derivation below is byte-identical to the
 * historical one-node plan, so a room with a single live item behaves exactly
 * as it always has.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u;
const SHA = /^[0-9a-f]{40}$/u;
/** A sibling parent inside the room stack is always a canonical node branch. */
export const STACK_PARENT_BRANCH = /^app-harness-os\/\d+\/g\d+$/u;

function safeId(value) {
	return typeof value === "string" && ID.test(value) ? value : null;
}

function safeBranch(value) {
	return typeof value === "string" && BRANCH.test(value) && !value.includes("..") && !value.endsWith("/") && !value.startsWith("-") ? value : null;
}

function safeSha(value) {
	return typeof value === "string" && SHA.test(value) ? value : null;
}

function normalizeNode(value) {
	if (!value || typeof value !== "object") return null;
	const workItemId = safeId(value.workItemId);
	const nodeId = safeId(value.nodeId);
	const branch = safeBranch(value.branch);
	const parentBranch = safeBranch(value.parentBranch);
	if (!workItemId || !nodeId || !branch || !parentBranch) return null;
	return {
		workItemId,
		nodeId,
		branch,
		headSha: safeSha(value.headSha),
		parentBranch,
		parentBaseSha: safeSha(value.parentBaseSha),
	};
}

function emptyStack() {
	return { stackId: null, baseSha: null, order: [], tip: null, stale: [] };
}

/**
 * The one durable room-stack record: `order` is the linear stack bottom-up,
 * `tip` mirrors the top node (headSha null = reserved, not yet pinned), and
 * `stale` marks survivors whose recorded parent left the stack — they stay
 * marked until they replan onto the current tip or end. The tip is always
 * recomputed from the order, so the two can never disagree in storage.
 */
export function normalizeRoomStack(value) {
	const raw = value && typeof value === "object" ? value : {};
	const order = [];
	const seen = new Set();
	if (Array.isArray(raw.order)) {
		for (const entry of raw.order) {
			const node = normalizeNode(entry);
			if (node && !seen.has(node.workItemId)) {
				seen.add(node.workItemId);
				order.push(node);
			}
		}
	}
	const stale = [];
	if (Array.isArray(raw.stale)) {
		for (const entry of raw.stale) {
			if (!entry || typeof entry !== "object") continue;
			const workItemId = safeId(entry.workItemId);
			const nodeId = safeId(entry.nodeId);
			const branch = safeBranch(entry.branch);
			if (workItemId && nodeId && branch && !seen.has(workItemId)) {
				seen.add(workItemId);
				stale.push({ workItemId, nodeId, branch });
			}
		}
	}
	if (!order.length && !stale.length) return emptyStack();
	const top = order.at(-1);
	return {
		stackId: safeId(raw.stackId),
		baseSha: safeSha(raw.baseSha),
		order,
		tip: top ? { branch: top.branch, headSha: top.headSha } : null,
		stale,
	};
}

/**
 * The pipeline rule: new work may only advance when the current tip is pinned
 * (its candidate head is known), so a dependent plan never has an unknowable
 * parent. An empty stack is trivially pinned, and the item holding the
 * reserved tip is exempt — its own run is exactly what will pin it.
 */
export function stackTipPinned(stack, workItemId) {
	const current = normalizeRoomStack(stack);
	if (!current.tip || current.tip.headSha !== null) return true;
	return workItemId !== undefined && current.order.at(-1)?.workItemId === workItemId;
}

/**
 * Append the accepted plan's node as the new reserved tip. The append
 * re-verifies the plan's recorded parent against the live tip, so a plan
 * staged against a stack that has since moved is refused instead of recorded:
 * a root append requires an empty stack, and a sibling append requires the
 * pinned tip it was derived from.
 */
export function appendReservedNode(stack, node) {
	const current = normalizeRoomStack(stack);
	const workItemId = safeId(node?.workItemId);
	const nodeId = safeId(node?.nodeId);
	const branch = safeBranch(node?.branch);
	const parentBranch = safeBranch(node?.parentBranch);
	const stackId = safeId(node?.stackId);
	if (!workItemId || !nodeId || !branch || !parentBranch || !stackId) return { appended: false, reason: "invalid-node", stack: current };
	if (current.order.some((entry) => entry.workItemId === workItemId) || current.stale.some((entry) => entry.workItemId === workItemId)) {
		return { appended: false, reason: "node-exists", stack: current };
	}
	if (parentBranch === "main") {
		if (current.order.length) return { appended: false, reason: "stack-not-empty", stack: current };
		const baseSha = safeSha(node?.parentBaseSha);
		if (!baseSha) return { appended: false, reason: "invalid-node", stack: current };
		return {
			appended: true,
			stack: {
				...current,
				stackId,
				baseSha,
				order: [{ workItemId, nodeId, branch, headSha: null, parentBranch, parentBaseSha: baseSha }],
				tip: { branch, headSha: null },
			},
		};
	}
	const top = current.order.at(-1);
	if (!top || top.headSha === null) return { appended: false, reason: "tip-unpinned", stack: current };
	if (top.branch !== parentBranch || top.headSha !== safeSha(node?.parentBaseSha)) return { appended: false, reason: "tip-mismatch", stack: current };
	if (current.stackId !== stackId) return { appended: false, reason: "stack-mismatch", stack: current };
	return {
		appended: true,
		stack: {
			...current,
			order: [...current.order, { workItemId, nodeId, branch, headSha: null, parentBranch, parentBaseSha: top.headSha }],
			tip: { branch, headSha: null },
		},
	};
}

/**
 * Pin a node's candidate head. When the node is the tip this is what unblocks
 * the next dependent plan: the tip's head becomes the immutable parent base
 * the next node builds on.
 */
export function pinStackNode(stack, workItemId, headSha) {
	const current = normalizeRoomStack(stack);
	const sha = safeSha(headSha);
	const index = current.order.findIndex((entry) => entry.workItemId === workItemId);
	if (index === -1 || !sha) return { pinned: false, stack: current };
	const order = current.order.map((entry, at) => (at === index ? { ...entry, headSha: sha } : entry));
	const top = order.at(-1);
	return { pinned: true, stack: { ...current, order, tip: { branch: top.branch, headSha: top.headSha } } };
}

/**
 * Remove an item's node from the stack: the truncation half of the
 * cascade-restack protocol. Every node above it survives but is marked stale
 * — its recorded parent is gone, so it must replan onto the current tip —
 * and the tip rolls back to the highest surviving node (or null). A stale
 * marking is also cleared here when the marked item itself ends or replans.
 * When nothing remains, the record resets so the next plan starts a fresh
 * stack epoch.
 */
export function truncateStack(stack, workItemId) {
	const current = normalizeRoomStack(stack);
	const index = current.order.findIndex((entry) => entry.workItemId === workItemId);
	if (index === -1) {
		const stale = current.stale.filter((entry) => entry.workItemId !== workItemId);
		if (stale.length === current.stale.length) return { removed: false, stack: current, staleWorkItemIds: [] };
		const next = { ...current, stale };
		return { removed: true, stack: next.order.length || next.stale.length ? next : emptyStack(), staleWorkItemIds: [] };
	}
	const order = current.order.slice(0, index);
	const above = current.order.slice(index + 1);
	const stale = [...current.stale, ...above.map((entry) => ({ workItemId: entry.workItemId, nodeId: entry.nodeId, branch: entry.branch }))];
	if (!order.length && !stale.length) return { removed: true, stack: emptyStack(), staleWorkItemIds: [] };
	const top = order.at(-1);
	return {
		removed: true,
		stack: { ...current, order, tip: top ? { branch: top.branch, headSha: top.headSha } : null, stale },
		staleWorkItemIds: above.map((entry) => entry.workItemId),
	};
}

/**
 * Pop the bottom node after its pull request merged: the cascade's forward
 * step. Survivors above are untouched — GitHub retargets them without
 * rebasing, so their provenance still verifies — and the recorded base
 * advances to the merge commit the stack now sits on. (Dormant until the
 * retarget-ingestion slice wires the merged fact to it.)
 */
export function popBottomNode(stack, workItemId, mergeCommitSha) {
	const current = normalizeRoomStack(stack);
	const bottom = current.order[0];
	const sha = safeSha(mergeCommitSha);
	if (!bottom || bottom.workItemId !== workItemId || !sha) return { popped: false, stack: current };
	const order = current.order.slice(1);
	if (!order.length && !current.stale.length) return { popped: true, stack: emptyStack() };
	const top = order.at(-1);
	return { popped: true, stack: { ...current, baseSha: sha, order, tip: top ? { branch: top.branch, headSha: top.headSha } : null } };
}

/** Whether the item's node was marked stale by a truncation below it. */
export function isStaleStackNode(stack, workItemId) {
	return normalizeRoomStack(stack).stale.some((entry) => entry.workItemId === workItemId);
}

/**
 * Derive the mechanical stack identity for an accepted plan from durable
 * ledger facts and the room stack. The model's decisions (summary, ciProfile,
 * the baseSha it read from GitHub) pass through; everything else is the
 * platform's own naming contract. With an empty stack the output is
 * byte-identical to the historical one-node derivation: nodeId root, parent
 * main, stackId minted from the item. On a non-empty stack the node stacks on
 * the pinned tip and shares the room's stack epoch; a reserved (unpinned) tip
 * yields parentBaseSha null, which the ledger's own plan validation refuses
 * with a teaching error. A replan of an item already on the stack derives
 * against the stack without that node — the restack that the room's
 * truncation makes durable when the plan commits.
 */
export function canonicalStackPlan(item, plan, stack) {
	const issue = item.artifacts?.issue;
	const issueNumber = Number.isSafeInteger(issue?.number) && issue.number >= 1 ? issue.number : plan.issueNumber;
	// A replan over an existing candidate is a restack: the next generation
	// gets a fresh branch so the stale candidate can never be revalidated.
	const priorCandidate = item.artifacts?.candidate;
	const floor = Number.isSafeInteger(priorCandidate?.generation) ? priorCandidate.generation + 1 : 1;
	const generation = Math.max(floor, Number.isSafeInteger(plan.generation) && plan.generation >= 1 ? plan.generation : 1);
	const baseSha = typeof plan.baseSha === "string" ? plan.baseSha : "";
	const effective = truncateStack(stack, item.id).stack;
	const revision = item.plan ? item.plan.revision + 1 : 1;
	const mintedStackId = typeof plan.stackId === "string" && plan.stackId.trim() ? plan.stackId : `stack-${item.id.slice(0, 8)}`;
	if (!effective.order.length) {
		return {
			...plan,
			revision,
			generation,
			issueNumber,
			nodeId: "root",
			parentBranch: "main",
			pullRequestBase: "main",
			parentBaseSha: baseSha,
			branch: `app-harness-os/${issueNumber}/g${generation}`,
			stackId: mintedStackId,
		};
	}
	const tip = effective.tip;
	return {
		...plan,
		revision,
		generation,
		issueNumber,
		nodeId: `n-${item.id.slice(0, 8)}`,
		parentBranch: tip.branch,
		pullRequestBase: tip.branch,
		parentBaseSha: tip.headSha,
		branch: `app-harness-os/${issueNumber}/g${generation}`,
		stackId: effective.stackId ?? mintedStackId,
	};
}
