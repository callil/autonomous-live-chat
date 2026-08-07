import type { OperatorCommand } from "./contracts";

export type ToolDefinition = {
	type: "function";
	function: {
		name: string;
		description: string;
		strict: true;
		parameters: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
	};
};

export type StageContext = {
	leaseId: string | null;
	minted: string;
	activeRunId: string;
	planBranch: string;
	issueNumber: number;
};

export const OPERATOR_LEASE_MS: number;
export const SYSTEM_PROMPT: string;
export const TOOLS: ToolDefinition[];
export const OBSERVATION_TOOLS: Set<string>;
export const STAGE_TOOLS: Set<string>;
export const PARKING_TOOLS: Set<string>;
export function commandFor(name: string, args: Record<string, unknown>, ctx: StageContext): OperatorCommand;
