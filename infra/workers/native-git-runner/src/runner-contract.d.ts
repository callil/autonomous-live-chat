export const AGENT_DEFAULT_MODEL: string;
export type AgentSummary = { model: string; responseIds: string[]; tools: string[] };
export function normalizeAgentSummary(value: unknown, expectedModel?: string): AgentSummary | null;
export function buildAgentInstructions(input: { repository: string; issueNumber: number; branch: string; stackId: string; generation: number }): string;
export function safeAgentFailure(value: unknown): string;
