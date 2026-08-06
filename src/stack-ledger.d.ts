export type StackMode = "single-fast" | "multi-restack";
export type StackLedgerStatus = "active" | "needs-restack" | "restacking" | "blocked" | "cancelled" | "completed";
export type StackNodeState = "ready" | "running" | "candidate" | "passed" | "needs-restack" | "blocked" | "failed" | "closed" | "merged";

export interface StackNode {
	id: string;
	intent: string;
	branchPrefix: string;
	branch: string;
	parentId: string | null;
	parentBranch: string;
	parentBaseSha: string | null;
	generation: number;
	state: StackNodeState;
	headSha: string | null;
	pullRequest: { number: number; url: string; state: "open" | "closed" | "merged" } | null;
	mergeSha?: string;
}

export interface StackLedger {
	schemaVersion: 1;
	id: string;
	repository: string;
	lane: string;
	mode: StackMode;
	nativeStack: null | {
		id: string;
		generation: number;
		order: string[];
		stage: "pending" | "syncing" | "retry-pending" | "synced" | "complete";
		attempt: number;
		attemptToken: string | null;
	};
	status: StackLedgerStatus;
	revision: number;
	generation: number;
	originalBaseSha: string;
	currentBaseSha: string;
	generationBaseSha: string;
	issue: {
		number: number;
		url: string;
		state: "open" | "closed";
		authority: "active" | "cancelled" | "completed";
		updatedAt: string | null;
	};
	nodes: StackNode[];
	runner: {
		stage: "pending" | "running" | "retry-pending" | "restack-pending" | "complete" | "failed" | "cancelled";
		attempt: number;
		nodeId: string | null;
		attemptToken: string | null;
	};
	promotion: {
		stage: "idle" | "candidate-ready" | "dispatch-pending" | "dispatched" | "validating" | "validated" | "merging" | "merged" | "blocked" | "cancelled";
		nodeId: string | null;
		dispatchKey: string | null;
		runId: string | null;
		headSha: string | null;
		mergeSha: string | null;
	};
	deployment: {
		stage: "idle" | "pending" | "deploying" | "retry-pending" | "deployed" | "blocked" | "cancelled";
		attempt: number;
		attemptToken: string | null;
		mergeSha: string | null;
		deploymentUrl: string | null;
	};
	integration: {
		required: boolean;
		validatedBaseSha: string | null;
		validatedHeadSha: string | null;
	};
	appliedEventIds: string[];
}

export interface CreateStackLedgerInput {
	id: string;
	repository: string;
	lane: string;
	issue: { number: number; url: string; updatedAt?: string };
	baseSha: string;
	nativeStackId?: string;
	nodes: Array<{ id: string; intent: string; branchPrefix: string }>;
}

interface StackEventBase {
	eventId: string;
	generation: number;
	expectedRevision?: number;
}

export type StackEvent =
	| (StackEventBase & { type: "issue-closed"; issueNumber: number; updatedAt?: string })
	| (StackEventBase & { type: "main-observed"; mainSha: string })
	| (StackEventBase & { type: "restack-started" })
	| (StackEventBase & { type: "runner-attempt-started"; nodeId: string; attemptToken: string })
	| (StackEventBase & { type: "runner-attempt-retryable"; attemptToken: string })
	| (StackEventBase & { type: "runner-attempt-failed"; attemptToken: string })
	| (StackEventBase & {
		type: "runner-candidate-recorded";
		nodeId: string;
		attemptToken: string;
		parentBranch: string;
		parentBaseSha: string;
		headSha: string;
		pullRequestNumber: number;
		pullRequestUrl: string;
	})
	| (StackEventBase & { type: "node-validation-recorded"; nodeId: string; headSha: string; outcome: "passed" | "failed" })
	| (StackEventBase & { type: "native-stack-sync-started"; attemptToken: string })
	| (StackEventBase & { type: "native-stack-sync-retryable"; attemptToken: string })
	| (StackEventBase & { type: "native-stack-reconciled"; nativeStackId: string; order: string[]; attemptToken: string })
	| (StackEventBase & { type: "pull-request-closed"; nodeId: string; pullRequestNumber: number; headSha: string })
	| (StackEventBase & { type: "promotion-planned"; nodeId: string; dispatchKey: string })
	| (StackEventBase & { type: "promotion-dispatched"; dispatchKey: string; runId: string })
	| (StackEventBase & { type: "promotion-validated"; dispatchKey: string; headSha: string; baseSha: string })
	| (StackEventBase & { type: "promotion-merge-started"; dispatchKey: string; currentMainSha: string; headSha: string })
	| (StackEventBase & { type: "promotion-merged"; dispatchKey: string; headSha: string; mergeSha: string })
	| (StackEventBase & { type: "deployment-attempt-started"; attemptToken: string; mergeSha: string })
	| (StackEventBase & { type: "deployment-attempt-retryable"; attemptToken: string })
	| (StackEventBase & { type: "deployment-failed"; attemptToken: string })
	| (StackEventBase & { type: "deployment-succeeded"; attemptToken: string; deploymentUrl: string });

export interface StackEventResult {
	ledger: StackLedger;
	disposition: "applied" | "duplicate" | "stale";
	reason: string;
}

export function createStackLedger(input: CreateStackLedgerInput): StackLedger;
export function validateStackLedger(ledger: StackLedger): StackLedger;
export function applyStackEvent(ledger: StackLedger, event: StackEvent): StackEventResult;
export function branchForGeneration(prefix: string, generation: number): string;
export function promotionKey(stackId: string, generation: number, nodeId: string, headSha: string, baseSha: string): string;
export function stackCancellationGroup(ledger: StackLedger): string;
