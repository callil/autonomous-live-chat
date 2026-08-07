/** Ledger, runner, and GitHub contracts mirrored from the durable authority. */

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

/** Public projection returned by the sole App Harness durable ledger. */
export type LedgerWorkItem = {
	id: string;
	version: number;
	phase: string;
	request: unknown;
	classification: LedgerClassification | null;
	plan: LedgerPlan | null;
	activeImplementation?: { key: string; runId: string; attempt: number; startedAt: number } | null;
	artifacts: Record<string, unknown>;
};

export type ExternalPhase = "validating" | "promoting" | "deployed" | "completed" | "retryable" | "needs_review" | "rejected";
export type EventSource = "cloudflare-os" | "github" | "runner" | "ci" | "system";

/** Exact command selected by the bounded operator model, one per tool call. */
export type OperatorCommand =
	| { kind: "classify"; classification: LedgerClassification; message: string }
	| { kind: "plan"; plan: LedgerPlan; message: string }
	| { kind: "create-issue"; title: string; body: string; classification: "triage" | "agent" | "needs-review" | "rejected" | "deployed" }
	| { kind: "implement"; runId: string }
	| { kind: "record-candidate"; runId: string; branch: string; headSha: string; pullRequestNumber: number; pullRequestUrl: string; message: string }
	| { kind: "promote"; pullRequestNumber: number; headSha: string; dispatchKey: string }
	| { kind: "record-state"; phase: ExternalPhase; artifacts?: Record<string, unknown>; message: string; source: EventSource };

/** Persisted solely by LedgerService before any command executes. */
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

/** Private RPC surface for the sole durable App Harness ledger. */
export interface AppHarnessLedger {
	snapshotWorkItem(input: { workItemId: string }): Promise<{ state: string; version: number; terminal: boolean } | null>;
	recordClassification(input: { workItemId: string; classification: LedgerClassification; message: string }): Promise<LedgerWorkItem>;
	recordPlan(input: { workItemId: string; plan: LedgerPlan; message: string }): Promise<LedgerWorkItem>;
	recordArtifacts(input: { workItemId: string; artifacts: Record<string, unknown>; message: string; source: EventSource }): Promise<LedgerWorkItem>;
	startImplementation(input: { workItemId: string; runId: string }): Promise<{ disposition: string; item: LedgerWorkItem }>;
	recordCandidate(input: { workItemId: string; runId: string; branch: string; headSha: string; pullRequestNumber: number; pullRequestUrl: string; message: string }): Promise<LedgerWorkItem>;
	recordExternalState(input: { workItemId: string; phase: ExternalPhase; artifacts?: Record<string, unknown>; message: string; source: EventSource }): Promise<LedgerWorkItem>;
	stageOperatorAction(input: { workItemId: string; expectedVersion: number; command: OperatorCommand }): Promise<StagedOperatorAction>;
	beginOperatorAction(input: { workItemId: string; actionId: number }): Promise<BeginOperatorAction>;
	completeOperatorAction(input: { workItemId: string; actionId: number; idempotencyKey: string; executionToken: string; result: unknown }): Promise<StagedOperatorAction>;
	rejectOperatorAction(input: { workItemId: string; actionId: number; executionToken: string; error?: string }): Promise<StagedOperatorAction>;
	/** Pushed external facts, including the operator's own credit-outage health note. */
	ingestExternalFact(input: unknown): Promise<{ accepted: boolean }>;
}

/** Disposable Cloudflare Sandbox direct-agent implementation surface. */
export interface NativeGitRunnerBinding {
	startRun(input: unknown): Promise<unknown>;
	inspectRun(input: { jobId: string; generation: number; runId: string }): Promise<unknown>;
}

/** Repository-scoped GitHub App surface. It has no durable workflow state. */
export interface GitHubRepositoryBinding {
	createIssue(input: { eventId: string; title: string; body: string; classification: "triage" | "agent" | "needs-review" | "rejected" | "deployed" }): Promise<{ issueNumber: number; issueUrl: string; existing?: true }>;
	closeAfterDeployment(input: { issueNumber: number; eventId: string; body: string; deploymentUrl: string }): Promise<{ issueNumber: number; state: "closed"; deploymentUrl: string }>;
	dispatchPromotion(input: { pullRequest: number; stackId: string; generation: number; issueNumber: number; parentBranch: string; headSha: string; dispatchKey: string; ciProfile: "visual" | "content" | "behavior" | "data" | "infrastructure" }): Promise<{ dispatchKey: string; dispatched: true }>;
	getMainSha(): Promise<{ sha: string }>;
	getCandidate(input: { branch: string; pullRequestBase: string }): Promise<{ number: number; url: string; headSha: string; base: string; state: string } | null>;
	observeCandidatePullRequest(input: { number: number }): Promise<{ number: number; state: string; merged: boolean; mergeableState: string }>;
	observeCandidateValidation(input: { pullRequest: number; headSha: string }): Promise<{ runId: number; status: string; conclusion: string | null; url: string; createdAt: string } | null>;
	updateClassification(input: { issueNumber: number; classification: "triage" | "agent" | "needs-review" | "rejected" | "deployed"; modelClassification?: { changeType: "visual" | "content" | "data" | "behavior" | "infrastructure"; scope: "localized" | "bounded" | "broad"; risk: "low" | "medium" | "high"; affectedSurface: "ui" | "copy" | "data" | "behavior" | "infrastructure"; reversible: boolean; executionEligibility: "eligible" | "needs_review"; ciProfile: "visual" | "content" | "behavior" | "data" | "infrastructure" } }): Promise<unknown>;
	postStatus(input: { issueNumber: number; eventId: string; body: string }): Promise<unknown>;
	findPromotionRun(input: { dispatchKey: string; createdAfter?: string }): Promise<{ runId: number; status: string; conclusion: string | null; url: string; createdAt: string } | null>;
	observeWorkflowRun(input: { runId: number }): Promise<{ runId: number; status: string; conclusion: string | null; url: string }>;
}
