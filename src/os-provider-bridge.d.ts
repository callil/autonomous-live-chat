export type OsPlanningManifest = {
	workItemId: string;
	issueUrl: string;
	repository: "callil/autonomous-live-chat";
	request: string;
	target?: { targetId: string; page: string; label?: string };
	stack: { id: string; lane: string; generation: number };
	runnerUrl: string;
	orchestratorUrl: string;
	issueNumber: number;
};

export type OsNativeGitJob = {
	jobId: string;
	repository: "callil/autonomous-live-chat";
	generation: number;
	candidate: {
		change: { kind: "documentation-task"; request: string };
		stack: { stackId: string; nodeId: "root"; branch: string; parentBranch: "main"; parentBaseSha: string | null; pullRequestBase: "main"; issueNumber: number };
	};
};

export function createOsPlanningManifest(input: { workItemId: string; issueUrl: string; request: string; target?: { targetId?: string; page?: string; label?: string }; room?: string; generation?: number }): OsPlanningManifest;
export function createOsNativeGitJob(input: { manifest: OsPlanningManifest; plan: { kind: "documentation-task"; request: string }; parentBaseSha?: string | null }): OsNativeGitJob;
export function classifyOsRunnerResponse(value: unknown): { phase: "building" | "needs_review"; detail: string; terminal: boolean };
