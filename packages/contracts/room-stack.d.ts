import type { LedgerPlan, LedgerWorkItem } from "./ledger.js";

export type RoomStackNode = {
	workItemId: string;
	nodeId: string;
	branch: string;
	headSha: string | null;
	parentBranch: string;
	parentBaseSha: string | null;
	/** GitHub retargeted this survivor to the stack base after the node below merged; provenance is otherwise untouched. */
	retargeted?: true;
};

export type RoomStackNodeContext = {
	/** 1-based from the bottom: position 1 is the only node that may promote. */
	position: number;
	size: number;
	/** Exact branch order beneath the node — the runner's topology assertion. */
	expectedOrder: string[];
	retargeted: boolean;
};

export type RoomStackStaleNode = { workItemId: string; nodeId: string; branch: string };

export type RoomStack = {
	stackId: string | null;
	baseSha: string | null;
	order: RoomStackNode[];
	tip: { branch: string; headSha: string | null } | null;
	stale: RoomStackStaleNode[];
};

export declare const STACK_PARENT_BRANCH: RegExp;

export declare function normalizeRoomStack(value: unknown): RoomStack;
export declare function stackTipPinned(stack: unknown, workItemId?: string): boolean;
export declare function appendReservedNode(
	stack: unknown,
	node: { workItemId: string; nodeId: string; branch: string; parentBranch: string; parentBaseSha: string | null; stackId: string },
): { appended: true; stack: RoomStack } | { appended: false; reason: string; stack: RoomStack };
export declare function pinStackNode(stack: unknown, workItemId: string, headSha: string): { pinned: boolean; stack: RoomStack };
export declare function truncateStack(stack: unknown, workItemId: string): { removed: boolean; stack: RoomStack; staleWorkItemIds: string[] };
export declare function popBottomNode(stack: unknown, workItemId: string, mergeCommitSha: string): { popped: boolean; stack: RoomStack };
export declare function markNodeRetargeted(stack: unknown, workItemId: string): { marked: boolean; stack: RoomStack };
export declare function isStaleStackNode(stack: unknown, workItemId: string): boolean;
export declare function stackNodeContext(stack: unknown, workItemId: string): RoomStackNodeContext | null;
export declare function canonicalStackPlan(item: LedgerWorkItem, plan: LedgerPlan, stack: unknown): LedgerPlan;
