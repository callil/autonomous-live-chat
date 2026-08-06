export type OsNativeGitJob = {
	jobId: string;
	repository: string;
	generation: number;
	issueUrl: string;
	room: string;
	stack: { id: string; lane: string; generation: number; baseSha: null; state: "awaiting-base-sha" };
	audit: string[];
	runnerUrl: string;
};
export function createOsNativeGitJob(input: { workItemId: string; issueUrl: string; room?: string; generation?: number }): OsNativeGitJob;
export function classifyOsRunnerResponse(value: unknown): { phase: "building" | "needs_review"; detail: string; terminal: boolean };
