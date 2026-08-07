export type LedgerPhase = "submitted" | "classified" | "delegated" | "implementing" | "candidate" | "validating" | "promoting" | "deployed" | "completed" | "retryable" | "needs_review" | "rejected";
export type LedgerClassification = {
	decision: "eligible" | "needs_review" | "rejected";
	changeType: "visual" | "content" | "data" | "behavior" | "infrastructure";
	scope: "localized" | "bounded" | "broad";
	risk: "low" | "medium" | "high";
	affectedSurface: "ui" | "copy" | "data" | "behavior" | "infrastructure";
	reversible: boolean;
	executionEligibility: "eligible" | "needs_review";
	ciProfile: "visual" | "content" | "behavior" | "data" | "infrastructure";
};
export type LedgerPlan = { revision: number; baseSha: string; stackId: string; generation: number; nodeId: string; branch: string; parentBranch: string; parentBaseSha: string | null; pullRequestBase: string; issueNumber: number; summary: unknown; ciProfile: string };
export type LedgerWorkItem = {
	schemaVersion: 1;
	id: string;
	room: string;
	request: unknown;
	target?: unknown;
	submissionId?: string;
	phase: LedgerPhase;
	version: number;
	classification: LedgerClassification | null;
	plan: LedgerPlan | null;
	activeImplementation: null | { key: string; runId: string; attempt: number; startedAt: number };
	artifacts: Record<string, any>;
	createdAt: number;
	updatedAt: number;
};

export const LEDGER_PHASES: readonly LedgerPhase[];
export const TERMINAL_LEDGER_PHASES: ReadonlySet<LedgerPhase>;
export function createLedgerWorkItem(input: { id: string; room: string; request: unknown; target?: unknown; submissionId?: string; now: number }): LedgerWorkItem;
export function recordLedgerClassification(item: LedgerWorkItem, input: { classification: LedgerClassification; now: number }): LedgerWorkItem;
export function recordLedgerPlan(item: LedgerWorkItem, input: { plan: LedgerPlan; now: number }): LedgerWorkItem;
export function implementationKey(item: LedgerWorkItem): string;
export function startLedgerImplementation(item: LedgerWorkItem, input: { runId: string; now: number }): { disposition: "started" | "resume" | "artifact-exists"; item: LedgerWorkItem };
export function recordLedgerCandidate(item: LedgerWorkItem, input: { runId: string; branch: string; headSha: string; pullRequestNumber: number; pullRequestUrl: string; now: number }): LedgerWorkItem;
export function recordLedgerExternalState(item: LedgerWorkItem, input: { phase: Extract<LedgerPhase, "validating" | "promoting" | "deployed" | "completed" | "retryable" | "needs_review" | "rejected">; artifacts?: Record<string, unknown>; now: number }): LedgerWorkItem;
