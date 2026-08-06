export const NANOCODEX_VERSION: string;
export const NANOCODEX_DEFAULT_MODEL: string;
export type AgentSummary = { model: string; responseIds: string[]; tools: string[] };
export function normalizeAgentSummary(value: unknown, expectedModel?: string): AgentSummary | null;
export function buildNanocodexInstructions(input: { repository: string; issueNumber: number; branch: string; stackId: string; generation: number }): string;
export function safeAgentFailure(value: unknown): string;
