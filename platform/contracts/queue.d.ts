export type RunState = "queued" | "running" | "verifying" | "deploying" | "merged" | "failed" | "parked";

export type RunVerification = { branch: string; prNumber: number; headSha: string };

export type QueuedRun = {
	runId: string;
	intentId: string;
	state: RunState;
	enqueuedAt: number;
	attemptId?: string;
	startedAt?: number;
	verifyingAt?: number;
	verification?: RunVerification;
	deployingAt?: number;
	mergeSha?: string;
	migration?: boolean;
	completedAt?: number;
	detail?: unknown;
};

export type QueueChipStatus = { runId: string; intentId: string; position: number; etaMs: number };

export const RUN_STATES: readonly RunState[];
export const TERMINAL_RUN_STATES: ReadonlySet<RunState>;
export const ACTIVE_RUN_STATES: ReadonlySet<RunState>;
export const RUN_TTL_MS: number;
export const VERIFY_TTL_MS: number;
export const DEPLOY_TTL_MS: number;
export const AVERAGE_RUN_MS: number;

export function activeRun(queue: QueuedRun[]): QueuedRun | null;
export function queuedRuns(queue: QueuedRun[]): QueuedRun[];
export function enqueueRun(queue: QueuedRun[], input: { runId: string; intentId: string; enqueuedAt: number }): QueuedRun[];
export function nextDispatch(queue: QueuedRun[]): QueuedRun | null;
export function startRun(queue: QueuedRun[], input: { runId: string; attemptId: string; startedAt: number }): QueuedRun[];
export function assertLiveAttempt(queue: QueuedRun[], input: { runId: string; attemptId: string }): QueuedRun;
export function validateVerification(value: unknown): RunVerification;
export function beginVerifying(queue: QueuedRun[], input: { runId: string; attemptId: string; at: number; verification: unknown }): QueuedRun[];
export function beginDeploying(queue: QueuedRun[], input: { runId: string; attemptId: string; at: number; mergeSha: string; migration?: boolean }): QueuedRun[];
export function completeRun(queue: QueuedRun[], input: { runId: string; attemptId: string; state: "merged" | "failed"; at: number; detail?: unknown }): QueuedRun[];
export function parkExpiredRun(queue: QueuedRun[], now: number, ttlMs?: number, verifyMs?: number, deployMs?: number): { queue: QueuedRun[]; parked: QueuedRun | null };
export function queueStatus(queue: QueuedRun[], now: number, averageRunMs?: number): QueueChipStatus[];
export function pruneTerminalRuns(queue: QueuedRun[], keep?: number): QueuedRun[];
export function withinDailyBudget(input: { spentUsd: number; budgetUsd: number; estimatedRunUsd: number }): boolean;
