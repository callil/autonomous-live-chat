/** Public projection returned by the sole App Harness durable ledger. */
export type LedgerWorkItem = {
	id: string;
	version: number;
	phase: string;
	request: unknown;
	lease: null | { operatorId: string; id: string; expiresAt: number };
	classification: LedgerClassification | null;
	plan: LedgerPlan | null;
	artifacts: Record<string, unknown>;
};

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

export type ClassificationInput = {
	workItemId: string;
	expectedVersion: number;
	leaseId: string;
	decision: string;
	changeType: string;
	scope: string;
	risk: string;
	affectedSurface: string;
	reversible: boolean;
	executionEligibility: string;
	ciProfile: string;
	message: string;
};

export type LedgerPlan = {
	revision: number;
	baseSha: string;
	stackId: string;
	generation: number;
	summary: unknown;
	ciProfile: string;
	nodeId: string;
	branch: string;
	parentBranch: string;
	parentBaseSha: string | null;
	pullRequestBase: string;
	issueNumber: number;
};

export type ExternalPhase = "validating" | "promoting" | "deployed" | "completed" | "retryable" | "needs_review" | "rejected";
export type EventSource = "cloudflare-os" | "github" | "runner" | "ci" | "system";

/**
 * Exact command selected by the persistent Cloudflare OS model. The model
 * chooses one of these after observing ledger state; this package never
 * derives a command from a work-item phase.
 */
export type OperatorCommand =
	| { kind: "claim"; leaseId: string; leaseMs: number }
	| { kind: "release"; leaseId: string }
	| { kind: "classify"; leaseId: string; classification: LedgerClassification; message: string }
	| { kind: "plan"; leaseId: string; plan: LedgerPlan; message: string }
	| { kind: "create-issue"; leaseId: string; title: string; body: string; classification: "triage" | "agent" | "needs-review" | "rejected" | "deployed" }
	| { kind: "implement"; leaseId: string; runId: string }
	| { kind: "record-candidate"; leaseId: string; runId: string; branch: string; headSha: string; pullRequestNumber: number; pullRequestUrl: string; message: string }
	| { kind: "promote"; leaseId: string; pullRequestNumber: number; headSha: string; dispatchKey: string }
	| { kind: "record-state"; leaseId: string; phase: ExternalPhase; artifacts?: Record<string, unknown>; message: string; source: EventSource }
	| { kind: "defer"; leaseId: string; delayMs: number; message: string };

/** Persisted solely by LedgerService before the Gatekeeper asks for approval. */
export type StagedOperatorAction = {
	id: number;
	workItemId: string;
	expectedVersion: number;
	idempotencyKey: string;
	command: OperatorCommand;
	status: "staged" | "applying" | "applied" | "rejected" | "needs_reconciliation";
	attempts: number;
	leaseExpiresAt?: number;
	executionToken?: string;
	result?: unknown;
	createdAt: number;
	updatedAt: number;
};

export type BeginOperatorAction = {
	disposition: "execute" | "busy" | "applied" | "rejected" | "stale";
	action: StagedOperatorAction;
	workItem: LedgerWorkItem;
	executionToken?: string;
};

export type StageInput = { workItemId: string; expectedVersion: number; command: OperatorCommand };
export type StagedActionResult = {
	actionId: number;
	workItemId: string;
	state: "queued" | "already-queued" | "completed" | "rejected";
	error?: string;
};

/** Agent-facing model-selected methods, kept deliberately typed and flat. */
export type OperatorSession = {
	listReady(input?: { limit?: number }): Promise<LedgerWorkItem[]>;
	getWorkItem(input: { workItemId: string }): Promise<LedgerWorkItem | null>;
	getAction(input: { actionId: number }): Promise<StagedOperatorAction | null>;
	listActions(input: { workItemId: string }): Promise<StagedOperatorAction[]>;
	inspectImplementation(input: { jobId: string; generation: number; runId: string }): Promise<unknown>;
	getMainSha(): Promise<{ sha: string }>;
	getCandidate(input: { branch: string; pullRequestBase: string }): Promise<{ number: number; url: string; headSha: string; base: string; state: string } | null>;
	observeCandidateValidation(input: { pullRequest: number; headSha: string }): Promise<{ runId: number; status: string; conclusion: string | null; url: string; createdAt: string } | null>;
	findPromotionRun(input: { dispatchKey: string; createdAfter?: string }): Promise<{ runId: number; status: string; conclusion: string | null; url: string; createdAt: string } | null>;
	inspectPromotionRun(input: { runId: number }): Promise<{ runId: number; status: string; conclusion: string | null; url: string }>;
	stageClaim(input: { workItemId: string; expectedVersion: number; leaseId: string; leaseMs: number }): Promise<StagedActionResult>;
	stageRelease(input: { workItemId: string; expectedVersion: number; leaseId: string }): Promise<StagedActionResult>;
	stageClassification(input: ClassificationInput): Promise<StagedActionResult>;
	stagePlan(input: { workItemId: string; expectedVersion: number; leaseId: string; plan: LedgerPlan; message: string }): Promise<StagedActionResult>;
	stageIssue(input: { workItemId: string; expectedVersion: number; leaseId: string; title: string; body: string; classification: "triage" | "agent" | "needs-review" | "rejected" | "deployed" }): Promise<StagedActionResult>;
	stageImplementation(input: { workItemId: string; expectedVersion: number; leaseId: string; runId: string }): Promise<StagedActionResult>;
	stageCandidate(input: { workItemId: string; expectedVersion: number; leaseId: string; runId: string; branch: string; headSha: string; pullRequestNumber: number; pullRequestUrl: string; message: string }): Promise<StagedActionResult>;
	stagePromotion(input: { workItemId: string; expectedVersion: number; leaseId: string; pullRequestNumber: number; headSha: string; dispatchKey: string }): Promise<StagedActionResult>;
	stageState(input: { workItemId: string; expectedVersion: number; leaseId: string; phase: ExternalPhase; artifacts?: Record<string, unknown>; message: string; source: EventSource }): Promise<StagedActionResult>;
	stageDefer(input: { workItemId: string; expectedVersion: number; leaseId: string; delayMs: number; message: string }): Promise<StagedActionResult>;
};
