import type { LedgerWorkItem } from "./ledger.js";

export type OperatorCommandLike =
	| { kind: "claim"; leaseId: string }
	| { kind: "release"; leaseId: string }
	| { kind: "defer"; leaseId: string; delayMs: number }
	| { kind: "classify" }
	| { kind: "create-issue" }
	| { kind: "plan"; plan: { revision: number } }
	| { kind: "implement"; runId: string }
	| { kind: "record-candidate"; runId: string }
	| { kind: "promote"; dispatchKey: string }
	| { kind: "record-state"; phase: string };

export function operatorActionEffectKey(workItemId: string, command: OperatorCommandLike): string;
export function assertOperatorCommandAllowed(workItem: LedgerWorkItem, command: OperatorCommandLike, now: number): void;
export function operatorCommandEffectSatisfied(workItem: LedgerWorkItem, command: OperatorCommandLike): boolean;
