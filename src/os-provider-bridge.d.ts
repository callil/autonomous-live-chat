export type DurableIssue = { number: number; url: string };

export type OsWorkspaceSubmission = {
	gadgetKey: "callil/autonomous-live-chat";
	chatKey: "repository-main";
	messageKey: string;
	gadgetTitle: string;
	prompt: string;
	chatGatewayRpcTarget: unknown;
};

export type OsNativeGitJob = {
	jobId: string;
	repository: "callil/autonomous-live-chat";
	generation: number;
	candidate: {
		change: { kind: "repository-task"; request: string };
		stack: { stackId: string; nodeId: "root"; branch: string; parentBranch: "main"; parentBaseSha: string | null; pullRequestBase: "main"; issueNumber: number };
	};
};

export function createOsWorkspaceSubmission(input: { workItemId: string; issue: DurableIssue; request: string; target?: { targetId?: string; page?: string }; responseTarget: unknown }): OsWorkspaceSubmission;
export function validateOsExecutionRequest(input: { workItemId: string; issueNumber: number }, durable: { workItemId: string; issue: DurableIssue }): { workItemId: string; issueNumber: number };
export function osExecutionDisposition(input: { terminal: boolean; existingEffect: boolean; jobStage: string }): "terminal" | "duplicate" | "queue";
export function osWorkspaceTurnDisposition(jobStage: string): "awaiting-action" | "delegated";
export function createOsNativeGitJob(input: { workItemId: string; issue: DurableIssue; request: string; generation?: number; parentBaseSha?: string | null }): OsNativeGitJob;
export function classifyOsRunnerResponse(value: unknown): { phase: "building" | "needs_review"; detail: string; terminal: boolean };
