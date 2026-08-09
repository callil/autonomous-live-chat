import type { QueuedRun, RunState } from "./queue.js";

export type ReconcileSnapshot = {
	now: number;
	frozen: boolean;
	queue: QueuedRun[];
	openIntents: Array<{ id: string; openedAt: number }>;
	budget: { spentUsd: number; budgetUsd: number; estimatedRunUsd: number };
	revert: { sha: string; dispatchedAt: number | null } | null;
	watchdog: { sha: string; until: number; migration: boolean } | null;
	doctorQueue?: unknown[];
};

export type ReconcileAction =
	| { kind: "dispatch-revert"; sha: string }
	| { kind: "observe-revert"; sha: string }
	| { kind: "park-run"; runId: string; intentId: string; phase: RunState }
	| { kind: "enqueue-intent"; intentId: string }
	| { kind: "observe-ci"; runId: string; attemptId?: string; prNumber: number; headSha: string }
	| { kind: "observe-deploy"; runId: string; attemptId?: string; mergeSha: string }
	| { kind: "liveness-check"; sha: string; migration: boolean }
	| { kind: "dispatch"; runId: string; intentId: string }
	| { kind: "announce-budget-exhausted" }
	| { kind: "consult-doctor" };

export function decide(snapshot: ReconcileSnapshot): ReconcileAction[];
