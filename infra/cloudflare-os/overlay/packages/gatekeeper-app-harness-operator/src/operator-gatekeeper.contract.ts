import type {
	BeginOperatorAction,
	LedgerClassification,
	LedgerPlan,
	LedgerWorkItem,
	OperatorCommand,
	StagedOperatorAction,
} from "./types";

/** Private RPC surface for the sole durable App Harness ledger. */
export interface AppHarnessLedger {
	listReady(input?: { limit?: number }): Promise<LedgerWorkItem[]>;
	getWorkItem(input: { workItemId: string }): Promise<LedgerWorkItem | null>;
	claim(input: { workItemId: string; leaseId: string; leaseMs: number }): Promise<LedgerWorkItem>;
	release(input: { workItemId: string; leaseId: string }): Promise<LedgerWorkItem>;
	defer(input: { workItemId: string; leaseId: string; delayMs: number; message: string }): Promise<LedgerWorkItem>;
	recordClassification(input: { workItemId: string; leaseId: string; classification: LedgerClassification; message: string }): Promise<LedgerWorkItem>;
	recordPlan(input: { workItemId: string; leaseId: string; plan: LedgerPlan; message: string }): Promise<LedgerWorkItem>;
	recordArtifacts(input: { workItemId: string; leaseId: string; artifacts: Record<string, unknown>; message: string; source: Extract<OperatorCommand, { kind: "record-state" }>["source"] }): Promise<LedgerWorkItem>;
	startImplementation(input: { workItemId: string; leaseId: string; runId: string }): Promise<{ disposition: string; item: LedgerWorkItem }>;
	recordCandidate(input: { workItemId: string; leaseId: string; runId: string; branch: string; headSha: string; pullRequestNumber: number; pullRequestUrl: string; message: string }): Promise<LedgerWorkItem>;
	recordExternalState(input: { workItemId: string; leaseId: string; phase: Extract<OperatorCommand, { kind: "record-state" }> ["phase"]; artifacts?: Record<string, unknown>; message: string; source: Extract<OperatorCommand, { kind: "record-state" }> ["source"] }): Promise<LedgerWorkItem>;
	stageOperatorAction(input: { workItemId: string; expectedVersion: number; command: OperatorCommand }): Promise<StagedOperatorAction>;
	getOperatorAction(input: { actionId: number }): Promise<StagedOperatorAction | null>;
	listOperatorActions(input: { workItemId: string }): Promise<StagedOperatorAction[]>;
	beginOperatorAction(input: { actionId: number }): Promise<BeginOperatorAction>;
	completeOperatorAction(input: { actionId: number; idempotencyKey: string; executionToken: string; result: unknown }): Promise<StagedOperatorAction>;
	rejectOperatorAction(input: { actionId: number; executionToken: string }): Promise<StagedOperatorAction>;
}

/** Disposable Cloudflare Sandbox/NanoCodex implementation surface. */
export interface NativeGitRunner {
	startRun(input: unknown): Promise<unknown>;
	inspectRun(input: { jobId: string; generation: number; runId: string }): Promise<unknown>;
}

/** Repository-scoped GitHub App surface. It has no durable workflow state. */
export interface GitHubRepository {
	createIssue(input: { eventId: string; title: string; body: string; classification: "triage" | "agent" | "needs-review" | "rejected" | "deployed" }): Promise<{ issueNumber: number; issueUrl: string; existing?: true }>;
	closeAfterDeployment(input: { issueNumber: number; eventId: string; body: string; deploymentUrl: string }): Promise<{ issueNumber: number; state: "closed"; deploymentUrl: string }>;
	dispatchPromotion(input: { pullRequest: number; stackId: string; generation: number; issueNumber: number; parentBranch: string; headSha: string; dispatchKey: string; ciProfile: "visual" | "content" | "behavior" | "data" | "infrastructure" }): Promise<{ dispatchKey: string; dispatched: true }>;
	getMainSha(): Promise<{ sha: string }>;
	getCandidate(input: { branch: string; pullRequestBase: string }): Promise<{ number: number; url: string; headSha: string; base: string; state: string } | null>;
	observeCandidateValidation(input: { pullRequest: number; headSha: string }): Promise<{ runId: number; status: string; conclusion: string | null; url: string; createdAt: string } | null>;
	updateClassification(input: { issueNumber: number; classification: "triage" | "agent" | "needs-review" | "rejected" | "deployed"; modelClassification?: { changeType: "visual" | "content" | "data" | "behavior" | "infrastructure"; scope: "localized" | "bounded" | "broad"; risk: "low" | "medium" | "high"; affectedSurface: "ui" | "copy" | "data" | "behavior" | "infrastructure"; reversible: boolean; executionEligibility: "eligible" | "needs_review"; ciProfile: "visual" | "content" | "behavior" | "data" | "infrastructure" } }): Promise<unknown>;
	postStatus(input: { issueNumber: number; eventId: string; body: string }): Promise<unknown>;
	findPromotionRun(input: { dispatchKey: string; createdAfter?: string }): Promise<{ runId: number; status: string; conclusion: string | null; url: string; createdAt: string } | null>;
	observeWorkflowRun(input: { runId: number }): Promise<{ runId: number; status: string; conclusion: string | null; url: string }>;
}
